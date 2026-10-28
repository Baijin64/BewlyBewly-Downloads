//! Task creation, projection and querying, matching `DownloadQueue.enqueue` and
//! `TaskStore.query` field for field.

use std::collections::BTreeMap;

use bewly_core::formats::{validate_options, DownloadOptions};
use bewly_core::naming::utf16_len;
use bewly_store::Store;
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::settings::Settings;

pub const ACTIVE_STATES: [&str; 6] = [
    "queued",
    "resolving",
    "downloading",
    "paused",
    "muxing",
    "postprocessing",
];

pub fn service_now() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}

fn iso_now() -> String {
    service_now()
}

fn valid_bvid(value: &str) -> bool {
    value.len() == 12
        && value.starts_with("BV")
        && value[2..].bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn safe_integer(value: Option<&Value>) -> Option<i64> {
    let number = match value? {
        Value::Number(number) => number.as_f64()?,
        _ => return None,
    };
    if !number.is_finite() || number.fract() != 0.0 || number.abs() > 9_007_199_254_740_991.0 {
        return None;
    }
    Some(number as i64)
}

pub fn validate_info(info: &Value) -> Result<Value, String> {
    let bvid = info.get("bvid").and_then(Value::as_str).unwrap_or_default();
    if !valid_bvid(bvid) {
        return Err("请使用 B 站普通视频的 BV 链接".into());
    }
    let title = info
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if title.is_empty() || utf16_len(title) > 500 {
        return Err("无效视频信息".into());
    }
    let pages = info
        .get("pages")
        .and_then(Value::as_array)
        .ok_or("无效视频信息")?;
    if pages.is_empty() || pages.len() > 10000 {
        return Err("无效视频信息".into());
    }
    let mut normalized_pages = Vec::with_capacity(pages.len());
    for page in pages {
        let cid = safe_integer(page.get("cid")).ok_or("无效分 P 信息")?;
        let index = safe_integer(page.get("page")).ok_or("无效分 P 信息")?;
        let part_title = page
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if cid <= 0 || index <= 0 || utf16_len(part_title) > 500 {
            return Err("无效分 P 信息".into());
        }
        let duration = page.get("duration").and_then(Value::as_f64).unwrap_or(0.0);
        normalized_pages.push(json!({
            "cid": cid,
            "page": index,
            "title": part_title,
            "duration": duration,
        }));
    }

    let author = info.get("author").and_then(Value::as_str).unwrap_or("");
    let description = info
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut normalized = Map::new();
    normalized.insert("bvid".into(), Value::String(bvid.to_string()));
    normalized.insert("title".into(), Value::String(title.to_string()));
    normalized.insert(
        "author".into(),
        Value::String(author.chars().take(200).collect()),
    );
    normalized.insert(
        "cover".into(),
        info.get("cover")
            .cloned()
            .unwrap_or(Value::String(String::new())),
    );
    normalized.insert(
        "uid".into(),
        json!(info.get("uid").and_then(Value::as_f64).unwrap_or(0.0)),
    );
    normalized.insert(
        "pubdate".into(),
        json!(info.get("pubdate").and_then(Value::as_f64).unwrap_or(0.0)),
    );
    normalized.insert(
        "description".into(),
        Value::String(description.chars().take(20000).collect()),
    );
    normalized.insert("pages".into(), Value::Array(normalized_pages));
    if let Some(group) = info.get("group") {
        if let Some(title) = group.get("title").and_then(Value::as_str) {
            let index = group.get("index").and_then(Value::as_f64).unwrap_or(1.0);
            normalized.insert(
                "group".into(),
                json!({
                    "title": title.chars().take(300).collect::<String>(),
                    "index": if index == 0.0 { 1.0 } else { index },
                }),
            );
        }
    }
    Ok(Value::Object(normalized))
}

pub fn public_task(task: &Value) -> Value {
    let mut clone = task.clone();
    if let Some(object) = clone.as_object_mut() {
        object.remove("prepared");
    }
    clone
}

fn options_equal(left: &Value, right: &DownloadOptions) -> bool {
    validate_options(left)
        .map(|options| &options == right)
        .unwrap_or(false)
}

fn duplicate_of<'a>(
    existing: &'a [Value],
    bvid: &str,
    cid: i64,
    directory: &str,
    options: &DownloadOptions,
) -> Option<&'a Value> {
    existing.iter().find(|task| {
        if task.get("bvid").and_then(Value::as_str) != Some(bvid) {
            return false;
        }
        if task.get("cid").and_then(Value::as_i64) != Some(cid) {
            return false;
        }
        if task.get("directory").and_then(Value::as_str) != Some(directory) {
            return false;
        }
        let status = task.get("status").and_then(Value::as_str).unwrap_or("");
        if matches!(status, "failed" | "cancelled") {
            return false;
        }
        if status == "completed" {
            let deleted = task.get("filesDeleted").and_then(Value::as_bool) == Some(true);
            let output = task.get("output").and_then(Value::as_str).unwrap_or("");
            if deleted || output.is_empty() || !std::path::Path::new(output).exists() {
                return false;
            }
        }
        task.get("options")
            .map(|value| options_equal(value, options))
            .unwrap_or(false)
    })
}

fn normalize_and_validate_url(url_str: &str) -> Result<String, String> {
    let normalized = if url_str.starts_with("//") {
        format!("https:{url_str}")
    } else {
        url_str.to_string()
    };
    let mut parsed =
        url::Url::parse(&normalized).map_err(|_| "视频接口返回了不受支持的媒体地址".to_string())?;

    let host = parsed.host_str().unwrap_or("").to_string();
    if host.is_empty() {
        return Err("视频接口返回了不受支持的媒体地址".to_string());
    }

    let is_local = host == "127.0.0.1" || host == "localhost";

    if is_local {
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            return Err(format!("视频接口返回了不受支持的媒体地址（{host}）"));
        }
        return Ok(parsed.to_string());
    }

    if parsed.scheme() == "http" {
        let _ = parsed.set_scheme("https");
    } else if parsed.scheme() != "https" {
        return Err(format!("视频接口返回了不受支持的媒体地址（{host}）"));
    }

    let host_lower = host.to_ascii_lowercase();
    let allowed_suffixes = [
        "bilivideo.com",
        "bilivideo.cn",
        "bilivideo.net",
        "hdslb.com",
        "bilibili.com",
    ];

    let matches_allowed = allowed_suffixes
        .iter()
        .any(|suffix| host_lower == *suffix || host_lower.ends_with(&format!(".{suffix}")));

    let matches_akamaized =
        host_lower.starts_with("upos-") && host_lower.ends_with(".akamaized.net");

    if !matches_allowed && !matches_akamaized {
        return Err(format!("视频接口返回了不受支持的媒体地址（{host}）"));
    }

    Ok(parsed.to_string())
}

/// Minimal `validatePrepared` port: keep the resolved stream URLs so the engine
/// can download without another playurl round trip.
pub fn validate_prepared(value: &Value) -> Result<Value, String> {
    if !value.is_object() {
        return Err("缺少视频解析结果".into());
    }
    let stream = |input: Option<&Value>| -> Result<Value, String> {
        let Some(input) = input else {
            return Ok(Value::Null);
        };
        let urls = input
            .get("urls")
            .and_then(Value::as_array)
            .ok_or("无效媒体列表")?;
        if urls.is_empty() || urls.len() > 10 {
            return Err("无效媒体列表".into());
        }
        let mut clean = Vec::with_capacity(urls.len());
        for url in urls {
            let text = url.as_str().ok_or("无效媒体列表")?;
            let clean_url = normalize_and_validate_url(text)?;
            clean.push(Value::String(clean_url));
        }
        Ok(json!({
            "urls": clean,
            "quality": input.get("quality").and_then(Value::as_f64).unwrap_or(0.0),
            "id": input.get("id").and_then(Value::as_f64).unwrap_or(0.0),
            "codec": input.get("codec").and_then(Value::as_f64).unwrap_or(0.0),
            "codecs": input.get("codecs").and_then(Value::as_str).unwrap_or(""),
            "bandwidth": input.get("bandwidth").and_then(Value::as_f64).unwrap_or(0.0),
        }))
    };
    let subtitle_tracks = match value.get("subtitleTracks").and_then(Value::as_array) {
        Some(tracks) => {
            let mut validated_tracks = Vec::new();
            for track in tracks.iter().take(10) {
                if let Some(url) = track.get("url").and_then(Value::as_str) {
                    let clean_url = normalize_and_validate_url(url)?;
                    let lang = track.get("language").and_then(Value::as_str).unwrap_or("");
                    let safe_lang = bewly_core::naming::safe_name(lang);
                    let mut truncated: String = safe_lang.chars().take(30).collect();
                    if truncated.is_empty() {
                        truncated = "default".into();
                    }
                    validated_tracks.push(json!({
                        "url": clean_url,
                        "language": truncated,
                    }));
                }
            }
            Some(validated_tracks)
        }
        None => None,
    };
    let mut map = serde_json::Map::new();
    map.insert("video".into(), stream(value.get("video"))?);
    map.insert("audio".into(), stream(value.get("audio"))?);
    if let Some(tracks) = subtitle_tracks {
        map.insert("subtitleTracks".into(), Value::Array(tracks));
    }
    let prepared_at = value
        .get("preparedAt")
        .and_then(Value::as_i64)
        .filter(|&t| t > 0)
        .unwrap_or_else(crate::lifetime::now_ms);
    map.insert("preparedAt".into(), json!(prepared_at));
    Ok(Value::Object(map))
}

pub fn enqueue(
    store: &Store,
    settings: &Settings,
    params: &Value,
    start: bool,
) -> Result<Vec<Value>, String> {
    let info = params
        .get("info")
        .ok_or("缺少视频解析结果：当前版本需要由浏览器提供视频信息")?;
    let info = validate_info(info)?;
    let options = validate_options(params.get("options").unwrap_or(&json!({})))?;
    let cids = params
        .get("cids")
        .and_then(Value::as_array)
        .ok_or("请选择 1–10000 个分 P")?;
    if cids.is_empty() || cids.len() > 10000 {
        return Err("请选择 1–10000 个分 P".into());
    }
    let pages = info["pages"].as_array().cloned().unwrap_or_default();
    let mut requested: Vec<i64> = Vec::new();
    for cid in cids {
        let value = safe_integer(Some(cid)).ok_or("所选分 P 不属于这个视频")?;
        if !pages
            .iter()
            .any(|page| page.get("cid").and_then(Value::as_i64) == Some(value))
        {
            return Err("所选分 P 不属于这个视频".into());
        }
        if !requested.contains(&value) {
            requested.push(value);
        }
    }

    let mut existing = store.tasks().map_err(|error| error.to_string())?;
    let mut jobs = Vec::with_capacity(requested.len());
    for cid in requested {
        let page = pages
            .iter()
            .find(|page| page.get("cid").and_then(Value::as_i64) == Some(cid))
            .cloned()
            .ok_or("所选分 P 不属于这个视频")?;
        let directory = settings.directory.clone();
        if let Some(duplicate) = duplicate_of(
            &existing,
            info["bvid"].as_str().unwrap_or(""),
            cid,
            &directory,
            &options,
        ) {
            let mut copy = duplicate.clone();
            if start && copy.get("status").and_then(Value::as_str) == Some("pending") {
                if let Some(object) = copy.as_object_mut() {
                    object.insert("status".into(), Value::String("queued".into()));
                }
                store.put_task(&copy).map_err(|error| error.to_string())?;
                if let Some(slot) = existing
                    .iter_mut()
                    .find(|task| task.get("id") == copy.get("id"))
                {
                    *slot = copy.clone();
                }
            }
            if let Some(object) = copy.as_object_mut() {
                object.insert("duplicate".into(), Value::Bool(true));
            }
            jobs.push(copy);
            continue;
        }

        let mut task = Map::new();
        task.insert("id".into(), Value::String(Uuid::new_v4().to_string()));
        task.insert("bvid".into(), info["bvid"].clone());
        task.insert("cid".into(), json!(cid));
        task.insert("title".into(), info["title"].clone());
        task.insert(
            "part".into(),
            page.get("title")
                .cloned()
                .unwrap_or(Value::String(String::new())),
        );
        task.insert("page".into(), page.get("page").cloned().unwrap_or(json!(1)));
        task.insert("pageCount".into(), json!(pages.len()));
        task.insert(
            "duration".into(),
            page.get("duration").cloned().unwrap_or(json!(0.0)),
        );
        task.insert("uid".into(), info["uid"].clone());
        task.insert("pubdate".into(), info["pubdate"].clone());
        task.insert("description".into(), info["description"].clone());
        if let Some(group) = info.get("group") {
            task.insert("group".into(), group.clone());
        }
        task.insert("author".into(), info["author"].clone());
        task.insert("cover".into(), info["cover"].clone());
        task.insert(
            "options".into(),
            serde_json::to_value(&options).map_err(|error| error.to_string())?,
        );
        task.insert("directory".into(), Value::String(directory));
        if let Some(prepared) = params
            .get("prepared")
            .and_then(Value::as_object)
            .and_then(|object| object.get(&cid.to_string()))
        {
            task.insert("prepared".into(), validate_prepared(prepared)?);
        }
        task.insert(
            "status".into(),
            Value::String(if start { "queued" } else { "pending" }.into()),
        );
        task.insert("progress".into(), json!(0));
        task.insert("speed".into(), json!(0));
        task.insert("error".into(), Value::String(String::new()));
        task.insert("createdAt".into(), Value::String(iso_now()));
        let task = Value::Object(task);
        store.put_task(&task).map_err(|error| error.to_string())?;
        existing.push(task.clone());
        jobs.push(task);
    }
    Ok(jobs)
}

pub fn edit_task(task: &mut Value, options_val: &Value) -> Result<Value, String> {
    let status = task.get("status").and_then(Value::as_str).unwrap_or("");
    if status != "pending" && status != "failed" {
        return Err("只能修改待下载或失败任务".into());
    }

    let output_empty = match task.get("output") {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.is_empty(),
        _ => false,
    };
    let artifacts_empty = match task.get("artifacts") {
        None | Some(Value::Null) => true,
        Some(Value::Object(map)) => map.is_empty(),
        _ => false,
    };
    if !output_empty || !artifacts_empty {
        return Err("已有输出文件的任务不可改配置，请重新添加".into());
    }

    let validated = validate_options(options_val)?;
    let options_json = serde_json::to_value(&validated).map_err(|e| e.to_string())?;

    let obj = task.as_object_mut().ok_or("任务数据格式错误")?;
    obj.insert("options".into(), options_json);
    obj.insert("updatedAt".into(), Value::String(service_now()));
    obj.remove("prepared");

    Ok(public_task(task))
}

#[derive(Debug, Default, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub pending: u64,
    pub active: u64,
    pub completed: u64,
    pub failed: u64,
}

pub struct QueryResult {
    pub items: Vec<Value>,
    pub total: usize,
    pub page: u32,
    pub page_size: u32,
    pub counts: Counts,
}

fn statuses_for(tab: &str) -> Option<&'static [&'static str]> {
    match tab {
        "pending" => Some(&["pending"]),
        "active" => Some(&ACTIVE_STATES),
        "completed" => Some(&["completed"]),
        "failed" => Some(&["failed", "cancelled"]),
        _ => None,
    }
}

/// Builds the naming view for a stored task.
pub fn view_of(task: &Value, directory: &str) -> bewly_core::naming::TaskView {
    use bewly_core::naming::{Group, TaskView};
    let options = validate_options(task.get("options").unwrap_or(&json!({}))).unwrap_or_default();
    TaskView {
        title: task
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        part: task
            .get("part")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        author: task
            .get("author")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        bvid: task
            .get("bvid")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        cid: task.get("cid").and_then(Value::as_u64).unwrap_or(0),
        page: task.get("page").and_then(Value::as_u64).unwrap_or(1) as u32,
        page_count: task.get("pageCount").and_then(Value::as_u64).unwrap_or(1) as u32,
        uid: task.get("uid").and_then(Value::as_f64).unwrap_or(0.0),
        pubdate: task.get("pubdate").and_then(Value::as_f64).unwrap_or(0.0),
        created_at: task
            .get("createdAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        description: task
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        cover: task
            .get("cover")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        directory: directory.to_string(),
        group: task.get("group").and_then(|group| {
            group
                .get("title")
                .and_then(Value::as_str)
                .map(|title| Group {
                    index: group.get("index").and_then(Value::as_u64).unwrap_or(1) as u32,
                    title: title.to_string(),
                    id: group
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                })
        }),
        options,
    }
}

pub fn counts(tasks: &[Value]) -> Counts {
    let mut result = Counts::default();
    for task in tasks {
        match task.get("status").and_then(Value::as_str).unwrap_or("") {
            "pending" => result.pending += 1,
            "completed" => result.completed += 1,
            "failed" | "cancelled" => result.failed += 1,
            status if ACTIVE_STATES.contains(&status) => result.active += 1,
            _ => {}
        }
    }
    result
}

pub fn query(tasks: &[Value], params: &Value) -> Result<QueryResult, String> {
    let tab = params.get("tab").and_then(Value::as_str).unwrap_or("all");
    let group = statuses_for(tab);
    if tab != "all" && group.is_none() {
        return Err("无效任务分类".into());
    }
    let page = params
        .get("page")
        .and_then(Value::as_f64)
        .unwrap_or(1.0)
        .max(1.0) as u32;
    let page_size = params
        .get("pageSize")
        .and_then(Value::as_f64)
        .unwrap_or(50.0)
        .clamp(1.0, 100.0) as u32;
    let search = params
        .get("search")
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .take(200)
        .collect::<String>();

    let filtered: Vec<&Value> = tasks
        .iter()
        .filter(|task| {
            let status = task.get("status").and_then(Value::as_str).unwrap_or("");
            match group {
                Some(allowed) if !allowed.contains(&status) => return false,
                _ => {}
            }
            if search.is_empty() {
                return true;
            }
            ["title", "part", "bvid"].iter().any(|key| {
                task.get(*key)
                    .and_then(Value::as_str)
                    .map(|value| value.contains(&search))
                    .unwrap_or(false)
            })
        })
        .collect();

    let total = filtered.len();
    let start = ((page as usize - 1) * page_size as usize).min(total);
    let end = (start + page_size as usize).min(total);
    Ok(QueryResult {
        items: filtered[start..end]
            .iter()
            .map(|task| public_task(task))
            .collect(),
        total,
        page,
        page_size,
        counts: counts(tasks),
    })
}

/// Builds the `uiTask` projection: an explicit whitelist that must never leak
/// signed media URLs, cookies or prepared plans into the snapshot file.
pub const UI_TASK_FIELDS: [&str; 22] = [
    "id",
    "bvid",
    "cid",
    "title",
    "part",
    "page",
    "author",
    "uid",
    "cover",
    "createdAt",
    "completedAt",
    "options",
    "status",
    "stage",
    "progress",
    "speed",
    "error",
    "output",
    "artifacts",
    "warnings",
    "filesDeleted",
    "legacyPath",
];

pub fn ui_task(task: &Value) -> Value {
    let mut projected = BTreeMap::new();
    if let Some(object) = task.as_object() {
        for field in UI_TASK_FIELDS {
            if let Some(value) = object.get(field) {
                projected.insert(field.to_string(), value.clone());
            }
        }
    }
    Value::Object(projected.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info() -> Value {
        json!({
            "bvid": "BV1xx411c7mD",
            "title": "标题",
            "author": "UP",
            "cover": "",
            "uid": 1,
            "pubdate": 1700000000,
            "description": "",
            "pages": [{ "cid": 11, "page": 1, "title": "P1", "duration": 10 }]
        })
    }

    #[test]
    fn info_validation_rejects_foreign_and_empty_payloads() {
        assert!(validate_info(&json!({})).is_err());
        assert!(validate_info(&json!({ "bvid": "av1", "title": "x", "pages": [] })).is_err());
        assert!(validate_info(&info()).is_ok());
    }

    #[test]
    fn cid_must_belong_to_the_video() {
        let store_dir = std::env::temp_dir().join(format!("bewly-tasks-{}", std::process::id()));
        let store = Store::open(&store_dir).unwrap();
        let settings = Settings::default();
        let params = json!({ "info": info(), "cids": [99], "options": {} });
        assert_eq!(
            enqueue(&store, &settings, &params, false).unwrap_err(),
            "所选分 P 不属于这个视频"
        );
    }

    #[test]
    fn ui_task_projection_drops_prepared_and_unknown_fields() {
        let task = json!({
            "id": "1", "title": "t", "prepared": { "secret": true }, "future": 1,
            "status": "pending", "options": {}
        });
        let projected = ui_task(&task);
        assert!(projected.get("prepared").is_none());
        assert!(projected.get("future").is_none());
        assert_eq!(projected["id"], "1");
    }

    #[test]
    fn query_counts_match_the_documented_groups() {
        let tasks = vec![
            json!({"id":"1","status":"pending"}),
            json!({"id":"2","status":"downloading"}),
            json!({"id":"3","status":"completed"}),
            json!({"id":"4","status":"cancelled"}),
        ];
        let counts = counts(&tasks);
        assert_eq!(counts.pending, 1);
        assert_eq!(counts.active, 1);
        assert_eq!(counts.completed, 1);
        assert_eq!(counts.failed, 1);
        let result = query(&tasks, &json!({ "tab": "failed" })).unwrap();
        assert_eq!(result.total, 1);
    }

    #[test]
    fn validate_prepared_domains_timestamp_and_local() {
        let valid_payload = json!({
            "video": {
                "urls": ["//xy.bilivideo.com/video.m4s", "http://upos-sz-mirror08c.akamaized.net/upgcxcode/1.m4s"],
                "quality": 80
            },
            "audio": {
                "urls": ["http://127.0.0.1:8080/audio.m4s", "http://localhost/audio2.m4s"],
                "quality": 30280
            },
            "subtitleTracks": [
                { "url": "//i0.hdslb.com/sub.json", "language": "zh-CN" }
            ]
        });

        let res = validate_prepared(&valid_payload).unwrap();
        let video_urls = res["video"]["urls"].as_array().unwrap();
        assert_eq!(video_urls[0], "https://xy.bilivideo.com/video.m4s");
        assert_eq!(
            video_urls[1],
            "https://upos-sz-mirror08c.akamaized.net/upgcxcode/1.m4s"
        );

        let audio_urls = res["audio"]["urls"].as_array().unwrap();
        assert_eq!(audio_urls[0], "http://127.0.0.1:8080/audio.m4s");
        assert_eq!(audio_urls[1], "http://localhost/audio2.m4s");

        let subs = res["subtitleTracks"].as_array().unwrap();
        assert_eq!(subs[0]["url"], "https://i0.hdslb.com/sub.json");

        assert!(res["preparedAt"].as_i64().unwrap() > 0);

        let with_timestamp = json!({
            "video": { "urls": ["https://xy.bilivideo.com/video.m4s"] },
            "preparedAt": 999999
        });
        let res2 = validate_prepared(&with_timestamp).unwrap();
        assert_eq!(res2["preparedAt"], 999999);

        let invalid_domain = json!({
            "video": { "urls": ["https://evil.com/video.m4s"] }
        });
        assert_eq!(
            validate_prepared(&invalid_domain).unwrap_err(),
            "视频接口返回了不受支持的媒体地址（evil.com）"
        );

        let invalid_sub = json!({
            "video": { "urls": ["https://xy.bilivideo.com/video.m4s"] },
            "subtitleTracks": [{ "url": "https://malicious.org/sub.srt" }]
        });
        assert_eq!(
            validate_prepared(&invalid_sub).unwrap_err(),
            "视频接口返回了不受支持的媒体地址（malicious.org）"
        );
    }

    #[test]
    fn edit_task_behavior_and_guards() {
        let mut pending_task = json!({
            "id": "t1",
            "status": "pending",
            "options": { "quality": 64 },
            "prepared": { "secret": "token" },
            "output": null,
            "artifacts": {}
        });

        let updated = edit_task(&mut pending_task, &json!({ "quality": 80 })).unwrap();
        assert_eq!(pending_task["options"]["quality"], 80);
        assert!(pending_task.get("prepared").is_none());
        assert!(pending_task.get("updatedAt").is_some());
        assert_eq!(updated["options"]["quality"], 80);
        assert!(updated.get("prepared").is_none());

        let mut failed_task = json!({
            "id": "t2",
            "status": "failed",
            "options": { "quality": 64 },
            "output": "",
            "artifacts": null
        });
        assert!(edit_task(&mut failed_task, &json!({ "quality": 116 })).is_ok());

        let mut running_task = json!({
            "id": "t3",
            "status": "downloading",
            "options": {}
        });
        assert_eq!(
            edit_task(&mut running_task, &json!({})).unwrap_err(),
            "只能修改待下载或失败任务"
        );

        let mut completed_task = json!({
            "id": "t4",
            "status": "completed",
            "options": {}
        });
        assert_eq!(
            edit_task(&mut completed_task, &json!({})).unwrap_err(),
            "只能修改待下载或失败任务"
        );

        let mut task_with_output = json!({
            "id": "t5",
            "status": "pending",
            "output": "C:\\videos\\output.mp4"
        });
        assert_eq!(
            edit_task(&mut task_with_output, &json!({})).unwrap_err(),
            "已有输出文件的任务不可改配置，请重新添加"
        );

        let mut task_with_artifacts = json!({
            "id": "t6",
            "status": "failed",
            "output": null,
            "artifacts": { "video": "C:\\videos\\video.mp4" }
        });
        assert_eq!(
            edit_task(&mut task_with_artifacts, &json!({})).unwrap_err(),
            "已有输出文件的任务不可改配置，请重新添加"
        );
    }
}
