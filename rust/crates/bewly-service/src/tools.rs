//! Local tool jobs: BV/AV conversion, history export and job bookkeeping.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use bewly_store::Store;
use serde_json::{json, Value};
use uuid::Uuid;

const ALPHABET: &[u8; 58] = b"FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf";
const XOR: i64 = 23_442_827_791_579;

/// Port of `convertVideoId` from `native/tools.mjs`.
pub fn convert_video_id(input: &str) -> Result<String, String> {
    let text = input.trim();
    let lower = text.to_ascii_lowercase();
    let numeric = if let Some(rest) = lower.strip_prefix("av") {
        Some(rest.to_string())
    } else if !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()) {
        Some(text.to_string())
    } else {
        None
    };
    if let Some(digits) = numeric {
        if digits.is_empty()
            || digits.starts_with('0')
            || !digits.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err("请输入 BV 或 AV 号".into());
        }
        let aid: i64 = digits.parse().map_err(|_| "AV 号超出支持范围")?;
        if aid >= 1i64 << 51 || aid <= 0 {
            return Err("AV 号超出支持范围".into());
        }
        let mut number = ((1i64 << 51) | aid) ^ XOR;
        let mut chars: Vec<u8> = b"BV1000000000".to_vec();
        let mut index = 11usize;
        while number > 0 {
            chars[index] = ALPHABET[(number % 58) as usize];
            number /= 58;
            if index == 0 {
                break;
            }
            index -= 1;
        }
        chars.swap(3, 9);
        chars.swap(4, 7);
        return Ok(String::from_utf8_lossy(&chars).into_owned());
    }

    let bytes = text.as_bytes();
    if bytes.len() != 12 || !text.starts_with("BV1") {
        return Err("请输入 BV 或 AV 号".into());
    }
    let mut chars = bytes.to_vec();
    chars.swap(3, 9);
    chars.swap(4, 7);
    let mut number: i64 = 0;
    for byte in &chars[3..] {
        let Some(position) = ALPHABET.iter().position(|item| item == byte) else {
            return Err("BV 号包含无效字符".into());
        };
        number = number
            .checked_mul(58)
            .and_then(|value| value.checked_add(position as i64))
            .ok_or("AV 号超出支持范围")?;
    }
    let aid = (number & ((1i64 << 51) - 1)) ^ XOR;
    if convert_video_id(&format!("av{aid}"))? != text {
        return Err("BV 号校验失败".into());
    }
    Ok(format!("av{aid}"))
}

pub fn store_job(store: &Store, job: &Value) -> Result<(), String> {
    let id = job
        .get("id")
        .and_then(Value::as_str)
        .ok_or("工具任务缺少 id")?;
    store.put_job(id, job).map_err(|error| error.to_string())
}

pub fn load_job(store: &Store, id: &str) -> Result<Option<Value>, String> {
    store.get_job(id).map_err(|error| error.to_string())
}

pub fn convert_job(store: &Store, input: &str) -> Result<Value, String> {
    let id = Uuid::new_v4().to_string();
    let created_at = crate::tasks::service_now();
    match convert_video_id(input) {
        Ok(text) => {
            let job = json!({
                "id": id,
                "status": "completed",
                "operation": "convertId",
                "createdAt": created_at,
                "result": { "text": &text },
                "text": text,
            });
            store_job(store, &job)?;
            Ok(job)
        }
        Err(error) => {
            let job = json!({
                "id": id,
                "status": "failed",
                "operation": "convertId",
                "createdAt": created_at,
                "error": error,
            });
            store_job(store, &job)?;
            Ok(job)
        }
    }
}

pub fn export_history(store: &Store, target_directory: &Path, format_opt: Option<&str>) -> Result<PathBuf, String> {
    if !target_directory.is_absolute() {
        return Err("请选择输出目录".into());
    }
    std::fs::create_dir_all(target_directory).map_err(|e| e.to_string())?;

    let tasks = store.tasks().map_err(|e| e.to_string())?;
    let downloaded: Vec<Value> = tasks
        .into_iter()
        .filter(|t| t.get("status").and_then(Value::as_str) == Some("completed"))
        .map(|task| {
            let path = if let Some(legacy_path) = task.get("legacyPath").and_then(Value::as_str) {
                legacy_path.to_string()
            } else if let Some(output) = task.get("output").and_then(Value::as_str) {
                Path::new(output)
                    .parent()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default()
            } else {
                task.get("directory")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            };
            let type_str = if let Some(lt) = task.get("legacyType").and_then(Value::as_str) {
                lt.to_string()
            } else if let Some(outputs) =
                task.pointer("/options/outputs").and_then(Value::as_array)
            {
                outputs
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" / ")
            } else {
                String::new()
            };
            json!({
                "vid": task.get("id").unwrap_or(&Value::Null),
                "uid": task.get("uid").unwrap_or(&json!(0)),
                "upname": task.get("author").unwrap_or(&json!("")),
                "title": task.get("title").unwrap_or(&json!("")),
                "bv": task.get("bvid").unwrap_or(&json!("")),
                "pic": task.get("cover").unwrap_or(&json!("")),
                "path": path,
                "downDate": task.get("completedAt").or_else(|| task.get("updatedAt")).unwrap_or(&json!("")),
                "type": type_str,
            })
        })
        .collect();

    if downloaded.is_empty() {
        return Err("没有可导出的已完成记录".into());
    }

    let payload = json!({ "downloaded": downloaded }).to_string();

    let now_date = crate::tasks::service_now();
    let date_prefix = if now_date.len() >= 10 {
        &now_date[..10]
    } else {
        "export"
    };
    let uuid_str = Uuid::new_v4().to_string();

    let (filename, content_bytes) = match format_opt {
        Some("json") => {
            (format!("bewly_history_{}-{}.json", date_prefix, &uuid_str[..8]), payload.into_bytes())
        }
        Some("csv") => {
            let mut csv = String::from("vid,uid,upname,title,bv,pic,path,downDate,type\n");
            for row in &downloaded {
                let escape = |val: &Value| -> String {
                    let s = match val {
                        Value::String(s) => s.as_str(),
                        _ => "",
                    };
                    if s.contains([',', '"', '\n', '\r']) {
                        format!("\"{}\"", s.replace('"', "\"\""))
                    } else {
                        s.to_string()
                    }
                };
                csv.push_str(&format!(
                    "{},{},{},{},{},{},{},{},{}\n",
                    escape(&row["vid"]),
                    row["uid"].as_i64().unwrap_or(0),
                    escape(&row["upname"]),
                    escape(&row["title"]),
                    escape(&row["bv"]),
                    escape(&row["pic"]),
                    escape(&row["path"]),
                    escape(&row["downDate"]),
                    escape(&row["type"]),
                ));
            }
            (format!("bewly_history_{}-{}.csv", date_prefix, &uuid_str[..8]), csv.into_bytes())
        }
        _ => {
            let encoded = crate::migration::encode_bilidownexport(&payload);
            (format!("bewly_history_{}-{}.bilidownexport", date_prefix, &uuid_str[..8]), encoded.into_bytes())
        }
    };

    let target = target_directory.join(filename);
    if target.exists() {
        return Err("输出文件已存在，已保留原文件".into());
    }

    let temporary = target_directory.join(format!(".bewly-tool-{}", Uuid::new_v4()));
    std::fs::write(&temporary, &content_bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, &target).map_err(|e| e.to_string())?;

    Ok(target)
}

pub fn job_map(job: &Value) -> BTreeMap<String, Value> {
    job.as_object()
        .map(|object| {
            object
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default()
}

fn format_timestamp(ts: i64) -> Result<String, String> {
    let offset = time::UtcOffset::current_local_offset().unwrap_or_else(|_| {
        time::UtcOffset::from_hms(8, 0, 0).unwrap()
    });
    let dt = time::OffsetDateTime::from_unix_timestamp(ts)
        .map_err(|e| format!("时间戳格式化失败：{e}"))?
        .to_offset(offset);
    Ok(format!(
        "{}/{}/{} {:02}:{:02}:{:02}",
        dt.year(),
        u8::from(dt.month()),
        dt.day(),
        dt.hour(),
        dt.minute(),
        dt.second()
    ))
}

fn resolve_output_directory(params: &Value, default_directory: &str) -> Result<PathBuf, String> {
    let dir_str = params
        .get("directory")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(default_directory);
    let dir = PathBuf::from(dir_str);
    if !dir.is_absolute() {
        return Err("请选择输出目录".into());
    }
    Ok(dir)
}

fn validate_source_file(
    path_val: Option<&Value>,
    allowed_exts: &[&str],
) -> Result<PathBuf, String> {
    let path_str = match path_val.and_then(Value::as_str) {
        Some(s) if !s.trim().is_empty() => s,
        _ => return Err("请选择支持的本地文件".into()),
    };
    let path = PathBuf::from(path_str);
    if !path.is_absolute() {
        return Err("请选择支持的本地文件".into());
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_ascii_lowercase()))
        .unwrap_or_default();
    if !allowed_exts
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(&ext))
    {
        return Err("请选择支持的本地文件".into());
    }
    let metadata = std::fs::metadata(&path).map_err(|_| "源文件不存在".to_string())?;
    if !metadata.is_file() {
        return Err("源文件不存在".into());
    }
    Ok(path)
}

fn atomic_write(target: &Path, content: &[u8]) -> Result<(), String> {
    if target.exists() {
        return Err("输出文件已存在，已保留原文件".into());
    }
    let parent = target
        .parent()
        .ok_or_else(|| "无法获取输出目录".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("创建输出目录失败：{e}"))?;

    let ext = target.extension().and_then(|s| s.to_str()).unwrap_or("");
    let temp_name = if ext.is_empty() {
        format!(".bewly-tool-{}", Uuid::new_v4())
    } else {
        format!(".bewly-tool-{}.{}", Uuid::new_v4(), ext)
    };
    let temporary = parent.join(temp_name);
    if let Err(e) = std::fs::write(&temporary, content) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("写入文件失败：{e}"));
    }
    if target.exists() {
        let _ = std::fs::remove_file(&temporary);
        return Err("输出文件已存在，已保留原文件".into());
    }
    if let Err(e) = std::fs::rename(&temporary, target) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("重命名临时文件失败：{e}"));
    }
    Ok(())
}

pub fn execute_tool(
    store: &Store,
    default_directory: &str,
    cookie: &str,
    params: &Value,
) -> Result<Value, String> {
    let op = params.get("op").and_then(Value::as_str).unwrap_or("");
    match op {
        "status" => {
            let id_owned: String;
            let id = if let Some(s) = params.get("id").and_then(Value::as_str) {
                s
            } else if let Some(n) = params.get("id").and_then(Value::as_i64) {
                id_owned = n.to_string();
                &id_owned
            } else {
                return Err("工具任务不存在".to_string());
            };
            load_job(store, id)?.ok_or_else(|| "工具任务不存在".to_string())
        }
        "cancel" => {
            let id_owned: String;
            let id_opt = if let Some(s) = params.get("id").and_then(Value::as_str) {
                Some(s)
            } else if let Some(n) = params.get("id").and_then(Value::as_i64) {
                id_owned = n.to_string();
                Some(id_owned.as_str())
            } else {
                None
            };
            if let Some(id) = id_opt {
                if let Ok(Some(mut job)) = load_job(store, id) {
                    if job.get("status").and_then(Value::as_str) == Some("running") {
                        job["status"] = json!("failed");
                        job["error"] = json!("已取消工具操作");
                        let _ = store_job(store, &job);
                    }
                }
            }
            Ok(json!({ "cancelled": true }))
        }
        "convertId" => {
            let input = params.get("input").and_then(Value::as_str).unwrap_or("");
            convert_job(store, input)
        }
        "joinTime" => {
            let ts = crate::net::fetch_join_time(cookie)?;
            let text = format_timestamp(ts)?;
            let id = Uuid::new_v4().to_string();
            let created_at = crate::tasks::service_now();
            let job = json!({
                "id": id,
                "status": "completed",
                "operation": "joinTime",
                "createdAt": created_at,
                "result": { "text": &text },
                "text": text,
            });
            store_job(store, &job)?;
            Ok(job)
        }
        "exportHistory" => {
            let directory = resolve_output_directory(params, default_directory)?;
            let format_opt = params.get("format").and_then(Value::as_str);
            let target = export_history(store, &directory, format_opt)?;
            let path_str = target.to_string_lossy().into_owned();
            let id = Uuid::new_v4().to_string();
            let created_at = crate::tasks::service_now();
            let job = json!({
                "id": id,
                "status": "completed",
                "operation": "exportHistory",
                "createdAt": created_at,
                "result": { "path": &path_str },
                "path": path_str,
            });
            store_job(store, &job)?;
            Ok(job)
        }
        "pick" => {
            #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
            {
                let mut dialog = rfd::FileDialog::new();
                if let Some(path_str) = params.get("path").and_then(Value::as_str) {
                    let p = Path::new(path_str);
                    if p.is_dir() {
                        dialog = dialog.set_directory(p);
                    }
                }
                let kind = params.get("kind").and_then(Value::as_str).unwrap_or("");
                match kind {
                    "audio" => {
                        dialog = dialog.add_filter(
                            "音频文件",
                            &["aac", "m4a", "m4s", "mp3", "flac", "mka", "eac3", "wav"],
                        );
                    }
                    "video" => {
                        dialog = dialog.add_filter("视频文件", &["m4s", "mp4", "mkv", "mov"]);
                    }
                    "cc" => {
                        dialog = dialog.add_filter("CC 字幕", &["json"]);
                    }
                    "srt" => {
                        dialog = dialog.add_filter("SRT 字幕", &["srt"]);
                    }
                    "legacy" => {
                        dialog = dialog.add_filter("Bilidown 历史", &["bilidownexport"]);
                    }
                    _ => {}
                }
                let chosen_path = if kind == "directory" {
                    dialog.pick_folder()
                } else {
                    dialog.pick_file()
                };
                let chosen = chosen_path.map(|p| p.to_string_lossy().into_owned());
                let cancelled = chosen.is_none();
                let id = Uuid::new_v4().to_string();
                let created_at = crate::tasks::service_now();
                let job = json!({
                    "id": id,
                    "status": "completed",
                    "operation": "pick",
                    "createdAt": created_at,
                    "result": { "path": chosen, "cancelled": cancelled },
                    "path": chosen,
                    "cancelled": cancelled,
                });
                store_job(store, &job)?;
                Ok(job)
            }
            #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
            {
                let _ = (store, params);
                Err("当前平台暂不支持原生文件选择器".into())
            }
        }
        "ccToSrt" => {
            let source = validate_source_file(params.get("source"), &[".json"])?;
            let metadata = std::fs::metadata(&source).map_err(|_| "源文件不存在".to_string())?;
            if metadata.len() > 10 * 1024 * 1024 {
                return Err("字幕文件超过 10 MB".into());
            }
            let directory = resolve_output_directory(params, default_directory)?;
            let content = std::fs::read_to_string(&source)
                .map_err(|e| format!("读取源文件失败：{e}"))?;
            let trimmed = content.strip_prefix('\u{feff}').unwrap_or(&content);
            let json_body: Value = serde_json::from_str(trimmed)
                .map_err(|e| format!("字幕内容不是合法 JSON：{e}"))?;
            let body = json_body.get("body").unwrap_or(&Value::Null);
            let srt_content = bewly_core::formats::to_srt(body)?;

            let stem = source
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            let target = directory.join(format!("{}.srt", bewly_core::naming::safe_name(stem)));
            if target.exists() {
                return Err("输出文件已存在，已保留原文件".into());
            }
            atomic_write(&target, srt_content.as_bytes())?;

            let path_str = target.to_string_lossy().into_owned();
            let id = Uuid::new_v4().to_string();
            let created_at = crate::tasks::service_now();
            let job = json!({
                "id": id,
                "status": "completed",
                "operation": "ccToSrt",
                "createdAt": created_at,
                "result": { "path": &path_str },
                "path": path_str,
            });
            store_job(store, &job)?;
            Ok(job)
        }
        "srtToText" => {
            let source = validate_source_file(params.get("source"), &[".srt"])?;
            let metadata = std::fs::metadata(&source).map_err(|_| "源文件不存在".to_string())?;
            if metadata.len() > 10 * 1024 * 1024 {
                return Err("字幕文件超过 10 MB".into());
            }
            let directory = resolve_output_directory(params, default_directory)?;
            let content = std::fs::read_to_string(&source)
                .map_err(|e| format!("读取源文件失败：{e}"))?;
            let line_breaks = params.get("lineBreaks").and_then(Value::as_bool) != Some(false);
            let text_content = bewly_core::formats::srt_text(&content, line_breaks)?;
            let suffix = if line_breaks { ".txt" } else { ".joined.txt" };

            let stem = source
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            let target = directory.join(format!("{}{suffix}", bewly_core::naming::safe_name(stem)));
            if target.exists() {
                return Err("输出文件已存在，已保留原文件".into());
            }
            atomic_write(&target, text_content.as_bytes())?;

            let path_str = target.to_string_lossy().into_owned();
            let id = Uuid::new_v4().to_string();
            let created_at = crate::tasks::service_now();
            let job = json!({
                "id": id,
                "status": "completed",
                "operation": "srtToText",
                "createdAt": created_at,
                "result": { "path": &path_str },
                "path": path_str,
            });
            store_job(store, &job)?;
            Ok(job)
        }
        "audioToMp3" => {
            let source = validate_source_file(
                params.get("source"),
                &[".aac", ".m4a", ".m4s", ".mp3", ".flac", ".mka", ".eac3", ".wav"],
            )?;
            let directory = resolve_output_directory(params, default_directory)?;
            let stem = source
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            let target = directory.join(format!("{}.mp3", bewly_core::naming::safe_name(stem)));
            if target.exists() {
                return Err("输出文件已存在，已保留原文件".into());
            }
            std::fs::create_dir_all(&directory)
                .map_err(|e| format!("创建输出目录失败：{e}"))?;
            bewly_media::transcode_mp3(&source, &target).map_err(|e| match e {
                bewly_media::MediaError::Exists => "输出文件已存在，已保留原文件".to_string(),
                other => other.to_string(),
            })?;

            let path_str = target.to_string_lossy().into_owned();
            let id = Uuid::new_v4().to_string();
            let created_at = crate::tasks::service_now();
            let job = json!({
                "id": id,
                "status": "completed",
                "operation": "audioToMp3",
                "createdAt": created_at,
                "result": { "path": &path_str },
                "path": path_str,
            });
            store_job(store, &job)?;
            Ok(job)
        }
        "mux" => {
            let video = validate_source_file(
                params.get("video"),
                &[".mp4", ".m4s", ".mkv", ".mov"],
            )?;
            let audio = validate_source_file(
                params.get("audio"),
                &[".aac", ".m4a", ".m4s", ".mp3", ".flac", ".mka", ".eac3", ".wav"],
            )?;
            let directory = resolve_output_directory(params, default_directory)?;
            let video_stem = video
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            let target = directory.join(format!("{}.merged.mkv", bewly_core::naming::safe_name(video_stem)));
            if target.exists() {
                return Err("输出文件已存在，已保留原文件".into());
            }
            std::fs::create_dir_all(&directory)
                .map_err(|e| format!("创建输出目录失败：{e}"))?;
            bewly_media::remux(Some(&video), Some(&audio), &target, "mkv", false).map_err(|e| match e {
                bewly_media::MediaError::Exists => "输出文件已存在，已保留原文件".to_string(),
                other => other.to_string(),
            })?;

            let path_str = target.to_string_lossy().into_owned();
            let id = Uuid::new_v4().to_string();
            let created_at = crate::tasks::service_now();
            let job = json!({
                "id": id,
                "status": "completed",
                "operation": "mux",
                "createdAt": created_at,
                "result": { "path": &path_str },
                "path": path_str,
            });
            store_job(store, &job)?;
            Ok(job)
        }
        _ => Err("未知辅助工具".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_published_identifiers() {
        assert_eq!(convert_video_id("av170001").unwrap(), "BV17x411w7KC");
        assert_eq!(convert_video_id("BV17x411w7KC").unwrap(), "av170001");
        assert_eq!(convert_video_id("170001").unwrap(), "BV17x411w7KC");
    }

    #[test]
    fn rejects_invalid_input() {
        assert_eq!(convert_video_id("hello").unwrap_err(), "请输入 BV 或 AV 号");
        assert_eq!(
            convert_video_id("BV17x411w7K!").unwrap_err(),
            "BV 号包含无效字符"
        );
        assert_eq!(convert_video_id("av0").unwrap_err(), "请输入 BV 或 AV 号");
    }

    #[test]
    fn round_trips_a_large_range() {
        for aid in [1i64, 2, 17, 999_999, 170_001, 1 << 40] {
            let bvid = convert_video_id(&format!("av{aid}")).unwrap();
            assert_eq!(convert_video_id(&bvid).unwrap(), format!("av{aid}"));
        }
    }

    #[test]
    fn test_execute_tool_cc_to_srt_and_existing_protection() {
        let test_dir = std::env::temp_dir().join(format!("bewly-test-cc-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&test_dir).unwrap();
        let store = Store::open(&test_dir.join("store")).unwrap();
        let source_file = test_dir.join("sample.json");
        let json_content = format!(
            "\u{feff}{}",
            json!({
                "body": [
                    { "from": 1.25, "to": 2.5, "content": "测试CC字幕" }
                ]
            })
        );
        std::fs::write(&source_file, json_content.as_bytes()).unwrap();

        let res = execute_tool(
            &store,
            test_dir.to_str().unwrap(),
            "",
            &json!({ "op": "ccToSrt", "source": source_file.to_str().unwrap() }),
        )
        .unwrap();

        assert_eq!(res["status"], "completed");
        assert_eq!(res["operation"], "ccToSrt");
        let srt_path_str = res["path"].as_str().unwrap();
        assert_eq!(res["result"]["path"], srt_path_str);
        assert!(Path::new(srt_path_str).exists());
        let srt_text = std::fs::read_to_string(srt_path_str).unwrap();
        assert!(srt_text.contains("00:00:01,250 --> 00:00:02,500"));
        assert!(srt_text.contains("测试CC字幕"));

        let job_id = res["id"].as_str().unwrap();
        let status_job = execute_tool(
            &store,
            "",
            "",
            &json!({ "op": "status", "id": job_id }),
        )
        .unwrap();
        assert_eq!(status_job["status"], "completed");

        let err = execute_tool(
            &store,
            test_dir.to_str().unwrap(),
            "",
            &json!({ "op": "ccToSrt", "source": source_file.to_str().unwrap() }),
        )
        .unwrap_err();
        assert_eq!(err, "输出文件已存在，已保留原文件");
    }

    #[test]
    fn test_execute_tool_srt_to_text_line_breaks_and_joined() {
        let test_dir = std::env::temp_dir().join(format!("bewly-test-srt-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&test_dir).unwrap();
        let store = Store::open(&test_dir.join("store")).unwrap();
        let srt_file = test_dir.join("video.srt");
        let srt_content = "1\n00:00:01,000 --> 00:00:02,000\n第一行字幕\n\n2\n00:00:03,000 --> 00:00:04,000\n第二行字幕\n";
        std::fs::write(&srt_file, srt_content.as_bytes()).unwrap();

        let res_breaks = execute_tool(
            &store,
            test_dir.to_str().unwrap(),
            "",
            &json!({ "op": "srtToText", "source": srt_file.to_str().unwrap(), "lineBreaks": true }),
        )
        .unwrap();
        assert_eq!(res_breaks["status"], "completed");
        let txt_path = res_breaks["path"].as_str().unwrap();
        assert!(txt_path.ends_with("video.txt"));
        let txt_content = std::fs::read_to_string(txt_path).unwrap();
        assert_eq!(txt_content.trim(), "第一行字幕\n第二行字幕");

        let err_breaks = execute_tool(
            &store,
            test_dir.to_str().unwrap(),
            "",
            &json!({ "op": "srtToText", "source": srt_file.to_str().unwrap(), "lineBreaks": true }),
        )
        .unwrap_err();
        assert_eq!(err_breaks, "输出文件已存在，已保留原文件");

        let res_joined = execute_tool(
            &store,
            test_dir.to_str().unwrap(),
            "",
            &json!({ "op": "srtToText", "source": srt_file.to_str().unwrap(), "lineBreaks": false }),
        )
        .unwrap();
        assert_eq!(res_joined["status"], "completed");
        let joined_path = res_joined["path"].as_str().unwrap();
        assert!(joined_path.ends_with("video.joined.txt"));
        let joined_content = std::fs::read_to_string(joined_path).unwrap();
        assert_eq!(joined_content.trim(), "第一行字幕第二行字幕");

        let err_joined = execute_tool(
            &store,
            test_dir.to_str().unwrap(),
            "",
            &json!({ "op": "srtToText", "source": srt_file.to_str().unwrap(), "lineBreaks": false }),
        )
        .unwrap_err();
        assert_eq!(err_joined, "输出文件已存在，已保留原文件");
    }

    #[test]
    fn test_execute_tool_join_time() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let test_dir = std::env::temp_dir().join(format!("bewly-test-jointime-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&test_dir).unwrap();
        let store = Store::open(&test_dir.join("store")).unwrap();

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let body = json!({
                    "code": 0,
                    "data": {
                        "pfs": {
                            "profile": {
                                "jointime": 1580000000
                            }
                        }
                    }
                })
                .to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });

        std::env::set_var("BEWLY_MEMBER_API_BASE", format!("http://127.0.0.1:{port}"));
        let res = execute_tool(&store, "", "SESSDATA=test", &json!({ "op": "joinTime" })).unwrap();
        std::env::remove_var("BEWLY_MEMBER_API_BASE");

        assert_eq!(res["status"], "completed");
        assert_eq!(res["operation"], "joinTime");
        let text = res["text"].as_str().unwrap();
        assert_eq!(res["result"]["text"], text);
        assert!(text.contains("2020"));
    }

    #[test]
    fn test_execute_tool_export_history() {
        let test_dir = std::env::temp_dir().join(format!("bewly-test-export-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&test_dir).unwrap();
        let store = Store::open(&test_dir.join("store")).unwrap();

        let err = execute_tool(
            &store,
            test_dir.to_str().unwrap(),
            "",
            &json!({ "op": "exportHistory" }),
        )
        .unwrap_err();
        assert_eq!(err, "没有可导出的已完成记录");

        store
            .put_task(&json!({
                "id": "vid999",
                "status": "completed",
                "title": "历史测试视频",
                "bvid": "BV1xx411c7mD",
                "directory": test_dir.to_str().unwrap(),
                "output": test_dir.join("out.mp4").to_str().unwrap(),
            }))
            .unwrap();

        let res = execute_tool(
            &store,
            test_dir.to_str().unwrap(),
            "",
            &json!({ "op": "exportHistory" }),
        )
        .unwrap();
        assert_eq!(res["status"], "completed");
        assert_eq!(res["operation"], "exportHistory");
        let export_path = res["path"].as_str().unwrap();
        assert_eq!(res["result"]["path"], export_path);
        assert!(Path::new(export_path).exists());
        let content = std::fs::read_to_string(export_path).unwrap();
        let decoded = crate::migration::decode_bilidownexport(&content).unwrap();
        assert!(decoded.contains("历史测试视频"));
    }

    #[test]
    fn test_execute_tool_cancel_and_validations() {
        let test_dir = std::env::temp_dir().join(format!("bewly-test-cancel-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&test_dir).unwrap();
        let store = Store::open(&test_dir.join("store")).unwrap();

        let running_job = json!({
            "id": "job-running-1",
            "status": "running",
            "operation": "test",
            "createdAt": "2026-01-01T00:00:00.000Z",
        });
        store_job(&store, &running_job).unwrap();

        let cancel_res = execute_tool(&store, "", "", &json!({ "op": "cancel", "id": "job-running-1" })).unwrap();
        assert_eq!(cancel_res["cancelled"], true);

        let updated_job = load_job(&store, "job-running-1").unwrap().unwrap();
        assert_eq!(updated_job["status"], "failed");
        assert_eq!(updated_job["error"], "已取消工具操作");

        let unknown_err = execute_tool(&store, "", "", &json!({ "op": "somethingUnknown" })).unwrap_err();
        assert_eq!(unknown_err, "未知辅助工具");

        let non_abs_err = execute_tool(&store, test_dir.to_str().unwrap(), "", &json!({ "op": "ccToSrt", "source": "rel/path.json" })).unwrap_err();
        assert_eq!(non_abs_err, "请选择支持的本地文件");

        let wrong_ext_err = execute_tool(&store, test_dir.to_str().unwrap(), "", &json!({ "op": "ccToSrt", "source": test_dir.join("wrong.txt").to_str().unwrap() })).unwrap_err();
        assert_eq!(wrong_ext_err, "请选择支持的本地文件");

        let not_found_err = execute_tool(&store, test_dir.to_str().unwrap(), "", &json!({ "op": "ccToSrt", "source": test_dir.join("nonexistent.json").to_str().unwrap() })).unwrap_err();
        assert_eq!(not_found_err, "源文件不存在");
    }
}
