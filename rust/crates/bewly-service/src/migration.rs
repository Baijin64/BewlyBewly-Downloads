//! Legacy Bilidown migration: reads the old Chromium Local Storage snapshot and
//! maps its six whitelisted keys onto the current settings schema, and imports/exports
//! legacy history (`.bilidownexport`) files.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use bewly_core::formats::validate_options;
use bewly_store::local_storage::{decode_entry, is_whitelisted};
use rusty_leveldb::LdbIterator;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

fn number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(item) => item.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        Value::Bool(true) => Some(1.0),
        Value::Bool(false) => Some(0.0),
        _ => None,
    }
}

pub fn default_legacy_profile() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            if !appdata.is_empty() {
                return Some(PathBuf::from(appdata).join("bilidown"));
            }
        }
        None
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            if !home.is_empty() {
                return Some(
                    PathBuf::from(home)
                        .join("Library")
                        .join("Application Support")
                        .join("bilidown"),
                );
            }
        }
        None
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        None
    }
}

pub fn is_legacy_app_running() -> bool {
    if std::env::var("BEWLY_SKIP_LEGACY_PROCESS_CHECK").as_deref() == Ok("1") {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new("tasklist.exe")
            .args(["/FI", "IMAGENAME eq Bilidown.exe", "/FO", "CSV", "/NH"])
            .creation_flags(0x08000000)
            .output();
        match output {
            Ok(out) => {
                let text = String::from_utf8_lossy(&out.stdout).to_ascii_lowercase();
                text.contains("bilidown.exe")
            }
            Err(_) => false,
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("pgrep")
            .args(["-x", "Bilidown"])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}

pub fn decode_bilidownexport(content: &str) -> Result<String, String> {
    let units: Vec<u16> = content.encode_utf16().map(|u| u ^ 54).collect();
    String::from_utf16(&units).map_err(|e| format!("无法读取 Bilidown 历史导出文件：{e}"))
}

pub fn encode_bilidownexport(json_str: &str) -> String {
    let units: Vec<u16> = json_str.encode_utf16().map(|u| u ^ 54).collect();
    String::from_utf16_lossy(&units)
}

pub fn legacy_cover(value: &str) -> String {
    if value.is_empty() || value.len() > 2048 {
        return String::new();
    }
    let normalized = if value.starts_with("//") {
        format!("https:{value}")
    } else {
        value.to_string()
    };
    let Ok(url) = url::Url::parse(&normalized) else {
        return String::new();
    };
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|p| p != 443)
    {
        return String::new();
    }
    let Some(host) = url.host_str() else {
        return String::new();
    };
    if host != "hdslb.com" && !host.ends_with(".hdslb.com") {
        return String::new();
    }
    let mut clean = url;
    let _ = clean.set_scheme("https");
    clean.to_string()
}

pub fn parse_legacy_history(content: &str) -> Result<(Vec<Value>, usize), String> {
    let decoded = decode_bilidownexport(content).map_err(|_| "无法读取 Bilidown 历史导出文件")?;
    let parsed: Value =
        serde_json::from_str(&decoded).map_err(|_| "无法读取 Bilidown 历史导出文件")?;
    let downloaded = parsed
        .get("downloaded")
        .and_then(Value::as_array)
        .ok_or("历史文件格式不正确或记录过多")?;
    if downloaded.len() > 100_000 {
        return Err("历史文件格式不正确或记录过多".into());
    }

    let mut records = Vec::new();
    let mut invalid = 0usize;

    for row in downloaded {
        let bv = row.get("bv").and_then(Value::as_str).unwrap_or("");
        let title = row.get("title").and_then(Value::as_str);
        let path = row.get("path").and_then(Value::as_str);

        let bv_valid = bv.len() == 12
            && bv.starts_with("BV")
            && bv[2..].bytes().all(|b| b.is_ascii_alphanumeric());

        let (Some(title), Some(path)) = (title, path) else {
            invalid += 1;
            continue;
        };

        if !bv_valid || !Path::new(path).is_absolute() {
            invalid += 1;
            continue;
        }

        let vid = row.get("vid").and_then(Value::as_str);
        let fallback_id = format!("{bv}:{title}:{path}");
        let legacy_source_id: String = vid.unwrap_or(&fallback_id).chars().take(500).collect();

        let mut hasher = Sha256::new();
        hasher.update(legacy_source_id.as_bytes());
        let hash_hex = hex::encode(hasher.finalize());
        let id = format!("legacy-{}", &hash_hex[..32]);

        let pic = row.get("pic").and_then(Value::as_str).unwrap_or("");
        let cover = legacy_cover(pic);

        let upname = row.get("upname").and_then(Value::as_str).unwrap_or("");
        let author: String = upname.chars().take(200).collect();

        let uid = row.get("uid").and_then(Value::as_f64).unwrap_or(0.0) as u64;

        let type_val = row.get("type").and_then(Value::as_str).unwrap_or("");
        let legacy_type: String = type_val.chars().take(500).collect();

        let down_date = row.get("downDate").and_then(Value::as_str).unwrap_or("");
        let completed_at: String = down_date.chars().take(100).collect();

        let title_truncated: String = title.chars().take(500).collect();

        records.push(json!({
            "id": id,
            "legacySourceId": legacy_source_id,
            "bvid": bv,
            "cid": 0,
            "title": title_truncated,
            "part": title_truncated,
            "page": 1,
            "author": author,
            "uid": uid,
            "cover": cover,
            "directory": path,
            "legacyPath": path,
            "legacyType": legacy_type,
            "status": "completed",
            "progress": 100,
            "speed": 0,
            "error": "",
            "options": validate_options(&json!({})).unwrap_or_default(),
            "createdAt": crate::tasks::service_now(),
            "completedAt": completed_at,
            "warnings": ["旧版记录仅保存目录，无法从记录中核对单个文件；不会自动重新下载"],
        }));
    }

    Ok((records, invalid))
}

pub fn map_legacy_settings(values: &BTreeMap<String, String>) -> Result<Value, String> {
    let setting: Value =
        serde_json::from_str(values.get("setting").map(String::as_str).unwrap_or("{}"))
            .unwrap_or_else(|_| json!({}));
    let audio_quality = match setting.get("audioQn").and_then(Value::as_str) {
        Some("dubi") => "dolby",
        Some("hi") => "hires",
        Some(other) => other,
        None => "auto",
    };
    let codec = match setting.get("videoEncoding").and_then(Value::as_str) {
        Some("avc1") => "avc",
        Some("av01") => "av1",
        Some("hev1") | Some("hvc1") => "hevc",
        _ => "auto",
    };
    let options = validate_options(&json!({
        "quality": number(setting.get("videoQn")).unwrap_or(0.0),
        "audioQuality": audio_quality,
        "codec": codec,
        "outputs": ["video"],
        "filenameTemplate": values.get("renameRule").filter(|value| !value.is_empty()).cloned().unwrap_or_else(|| "%title%".into()),
        "folderTemplate": values.get("folderRenameRule").cloned().unwrap_or_default(),
        "createFolder": values.get("createFolder").map(String::as_str) == Some("true"),
        "createFolderAddIndex": values.get("createFolderAddIndex").map(String::as_str) == Some("true"),
    }))?;

    let max_concurrent = number(setting.get("maxDownCount"))
        .unwrap_or(1.0)
        .clamp(1.0, 4.0) as u32;
    let feature = |key: &str| setting.get(key).and_then(Value::as_bool) == Some(true);

    let mut settings = json!({
        "defaultOptions": options,
        "maxConcurrent": max_concurrent,
        "features": {
            "cover": feature("pic"),
            "audio": feature("music"),
            "xml": feature("xml"),
            "ass": feature("ass"),
            "nfo": feature("guaxiao"),
            "srt": feature("zimu"),
            "tools": feature("tools"),
        },
        "soundTip": setting.get("soundTip").and_then(Value::as_bool) != Some(false),
        "shutdown": false,
        "listenClipboard": false,
    });
    if let Some(directory) = values.get("defaultDownPath") {
        if Path::new(directory).is_absolute() {
            settings["directory"] = Value::String(directory.clone());
        }
    }
    Ok(settings)
}

fn snapshot_leveldb(source: &Path, data_directory: &Path) -> Result<PathBuf, String> {
    if !source.join("CURRENT").exists() {
        return Err("没有找到旧版 Bilidown 配置".into());
    }
    let snapshot = data_directory.join(format!("migration-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&snapshot).map_err(|error| error.to_string())?;
    let entries = std::fs::read_dir(source).map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let allowed = name == "CURRENT"
            || (name.starts_with("MANIFEST-")
                && name[9..].bytes().all(|byte| byte.is_ascii_digit()))
            || (name.ends_with(".log") || name.ends_with(".ldb") || name.ends_with(".sst"))
                && name
                    .split('.')
                    .next()
                    .map(|stem| stem.bytes().all(|byte| byte.is_ascii_digit()))
                    .unwrap_or(false);
        if !allowed {
            continue;
        }
        let path = entry.path();
        let before = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if !before.file_type().is_file() {
            return Err("旧配置文件类型异常".into());
        }
        std::fs::copy(&path, snapshot.join(&name)).map_err(|error| error.to_string())?;
        let after = std::fs::metadata(&path).map_err(|error| error.to_string())?;
        if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
            return Err("旧配置仍在变化，请退出旧版后重试".into());
        }
    }
    Ok(snapshot)
}

pub fn read_legacy_settings(profile: &Path, data_directory: &Path) -> Result<Value, String> {
    if is_legacy_app_running() {
        return Err("请先退出旧版 Bilidown，再读取配置，避免复制到使用中的数据库".into());
    }
    let source = profile.join("Local Storage").join("leveldb");
    let snapshot = snapshot_leveldb(&source, data_directory)?;
    let result = (|| {
        let options = rusty_leveldb::Options {
            create_if_missing: false,
            ..Default::default()
        };
        let mut database =
            rusty_leveldb::DB::open(&snapshot, options).map_err(|error| error.to_string())?;
        let mut values: BTreeMap<String, String> = BTreeMap::new();
        let mut key = Vec::new();
        let mut value = Vec::new();
        let mut iterator = database.new_iter().map_err(|error| error.to_string())?;
        iterator.seek_to_first();
        while iterator.valid() {
            if iterator.current(&mut key, &mut value) {
                if let Some(entry) = decode_entry(&key, &value) {
                    if is_whitelisted(&entry.name) {
                        values.insert(entry.name, entry.value);
                    }
                }
            }
            iterator.advance();
        }
        if !values.contains_key("setting") {
            return Err("旧数据库中没有可识别的下载设置".into());
        }
        map_legacy_settings(&values)
    })();
    let _ = std::fs::remove_dir_all(&snapshot);
    result
}

pub fn preview(
    store: &bewly_store::Store,
    data_directory: &Path,
    params: &Value,
) -> Result<Value, String> {
    let mut warnings: Vec<String> = vec![
        "不迁移登录信息。自动关机与剪贴板监听保持关闭，可在新设置中主动启用。".into(),
        "旧版窗口的关闭方式不迁移；新助手继续使用已选择的后台与托盘设置。".into(),
    ];

    let mut settings_val = Value::Null;
    let mut profile = params
        .get("profile")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);

    if params.get("settings").and_then(Value::as_bool) != Some(false) {
        if profile.is_none() {
            profile = default_legacy_profile();
        }
        let profile_path = match profile.as_ref() {
            Some(path) if !path.as_os_str().is_empty() => path.clone(),
            _ => return Err("当前平台没有旧版 Bilidown 数据，可通过导出文件导入历史".into()),
        };
        settings_val = read_legacy_settings(&profile_path, data_directory)?;
    }

    let mut records: Vec<Value> = Vec::new();
    let mut invalid = 0usize;

    if let Some(history_file) = params.get("historyFile").and_then(Value::as_str) {
        let history_path = Path::new(history_file);
        let ext = history_path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase());
        if !history_path.is_absolute() || ext.as_deref() != Some("bilidownexport") {
            return Err("请选择原版导出的 .bilidownexport 文件".into());
        }
        let metadata = std::fs::metadata(history_path).map_err(|error| error.to_string())?;
        if metadata.len() > 50 * 1024 * 1024 {
            return Err("历史文件超过 50 MB".into());
        }
        let content = std::fs::read_to_string(history_path).map_err(|error| error.to_string())?;
        let (parsed_records, inv) = parse_legacy_history(&content)?;
        records = parsed_records;
        invalid = inv;
    }

    let existing_tasks = store.tasks().unwrap_or_default();
    let duplicate = records
        .iter()
        .filter(|record| {
            let id = record.get("id").and_then(Value::as_str).unwrap_or("");
            let legacy_id = record
                .get("legacySourceId")
                .and_then(Value::as_str)
                .unwrap_or("");
            existing_tasks.iter().any(|t| {
                let t_id = t.get("id").and_then(Value::as_str).unwrap_or("");
                let t_legacy = t
                    .get("legacySourceId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                t_id == id
                    || (!legacy_id.is_empty() && (t_id == legacy_id || t_legacy == legacy_id))
            })
        })
        .count();

    let missing_directories = records
        .iter()
        .filter(|record| {
            let dir = record
                .get("directory")
                .and_then(Value::as_str)
                .unwrap_or("");
            !dir.is_empty() && !Path::new(dir).exists()
        })
        .count();

    if missing_directories > 0 {
        warnings.push(format!("{missing_directories} 条记录的保存目录已不存在"));
    }

    let sample: Vec<Value> = records
        .iter()
        .take(10)
        .map(|record| {
            json!({
                "title": record.get("title").cloned().unwrap_or(Value::Null),
                "bvid": record.get("bvid").cloned().unwrap_or(Value::Null),
                "directory": record.get("directory").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();

    Ok(json!({
        "settings": settings_val,
        "profile": profile.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        "records": records,
        "total": records.len(),
        "duplicate": duplicate,
        "invalid": invalid,
        "missingDirectories": missing_directories,
        "warnings": warnings,
        "sample": sample,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::PathBuf;

    fn profile() -> PathBuf {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../bewly-store/tests/fixtures/localstorage-leveldb");
        let root = std::env::temp_dir().join(format!(
            "bewly-migration-{}-{}",
            std::process::id(),
            time::OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        let leveldb = root.join("Local Storage").join("leveldb");
        std::fs::create_dir_all(&leveldb).unwrap();
        for entry in std::fs::read_dir(&fixture).unwrap().flatten() {
            let name = entry.file_name();
            if name.to_string_lossy() == "LOCK" {
                continue;
            }
            std::fs::copy(entry.path(), leveldb.join(name)).unwrap();
        }
        root
    }

    #[test]
    fn maps_the_six_whitelisted_keys() {
        let settings = read_legacy_settings(&profile(), &std::env::temp_dir()).unwrap();
        assert_eq!(settings["maxConcurrent"], 4);
        assert_eq!(settings["defaultOptions"]["quality"], 112);
        assert_eq!(settings["defaultOptions"]["audioQuality"], "hires");
        assert_eq!(settings["defaultOptions"]["codec"], "hevc");
        assert_eq!(
            settings["defaultOptions"]["filenameTemplate"],
            "%index:01%-%title%"
        );
        assert_eq!(settings["features"]["cover"], true);
        assert_eq!(settings["shutdown"], false);
        assert_eq!(settings["listenClipboard"], false);
        assert!(settings["directory"].as_str().unwrap().contains("视频"));
    }

    #[test]
    fn rejects_a_profile_without_a_database() {
        let empty = std::env::temp_dir().join(format!("bewly-empty-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        assert_eq!(
            read_legacy_settings(&empty, &std::env::temp_dir()).unwrap_err(),
            "没有找到旧版 Bilidown 配置"
        );
    }

    #[test]
    fn round_trips_bilidownexport_content() {
        let original = json!({
            "downloaded": [
                {
                    "vid": "123",
                    "bv": "BV17x411w7KC",
                    "title": "视频😀",
                    "pic": "http://i0.hdslb.com/bfs/archive/fixture.jpg@240w",
                    "path": "C:\\Downloads",
                    "downDate": "2024-11-07"
                }
            ]
        })
        .to_string();
        let encoded = encode_bilidownexport(&original);
        assert_ne!(encoded, original);
        let decoded = decode_bilidownexport(&encoded).unwrap();
        assert_eq!(decoded, original);
        let (records, invalid) = parse_legacy_history(&encoded).unwrap();
        assert_eq!(invalid, 0);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["title"], "视频😀");
        assert_eq!(
            records[0]["cover"],
            "https://i0.hdslb.com/bfs/archive/fixture.jpg@240w"
        );
    }

    #[test]
    fn legacy_cover_filters_unrelated_domains() {
        assert_eq!(
            legacy_cover("http://i0.hdslb.com/cover.jpg"),
            "https://i0.hdslb.com/cover.jpg"
        );
        assert_eq!(
            legacy_cover("//i1.hdslb.com/test.png"),
            "https://i1.hdslb.com/test.png"
        );
        assert_eq!(legacy_cover("https://evil.com/cover.jpg"), "");
    }

    #[test]
    fn default_legacy_profile_derivation() {
        if cfg!(target_os = "windows") && std::env::var("APPDATA").is_ok() {
            let profile = default_legacy_profile();
            assert!(profile.is_some());
            assert!(profile.unwrap().ends_with("bilidown"));
        }
    }

    #[test]
    fn process_check_honors_skip_flag() {
        std::env::set_var("BEWLY_SKIP_LEGACY_PROCESS_CHECK", "1");
        assert!(!is_legacy_app_running());
    }
}
