//! Legacy Bilidown migration: reads the old Chromium Local Storage snapshot and
//! maps its six whitelisted keys onto the current settings schema.
//!
//! History (`.bilidownexport`) import is still handled by the Node build; the
//! Rust service reports it as not migrated instead of silently importing a
//! partial subset.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use bewly_core::formats::validate_options;
use bewly_store::local_storage::{decode_entry, is_whitelisted};
use rusty_leveldb::LdbIterator;
use serde_json::{json, Value};
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

pub fn preview(data_directory: &Path, params: &Value) -> Result<Value, String> {
    if params.get("settings").and_then(Value::as_bool) == Some(false) {
        return Err("历史记录导入尚未迁移到 Rust 引擎".into());
    }
    let profile = match params.get("profile").and_then(Value::as_str) {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => return Err("当前平台没有旧版 Bilidown 数据，可通过导出文件导入历史".into()),
    };
    let settings = read_legacy_settings(&profile, data_directory)?;
    Ok(json!({
        "settings": settings,
        "profile": profile.to_string_lossy(),
        "warnings": [
            "不迁移登录信息。自动关机与剪贴板监听保持关闭，可在新设置中主动启用。",
            "旧版窗口的关闭方式不迁移；新助手继续使用已选择的后台与托盘设置。",
        ],
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
}
