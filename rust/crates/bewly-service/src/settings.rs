//! Download settings, validated with the same rules and messages as the Node build.

use std::path::PathBuf;

use bewly_core::formats::{validate_options, DownloadOptions};
use bewly_core::naming::utf16_len;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const VERSION: &str = "0.2.8";
pub const PROTOCOL: u32 = 2;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Features {
    pub cover: bool,
    pub audio: bool,
    pub xml: bool,
    pub ass: bool,
    pub nfo: bool,
    pub srt: bool,
    pub tools: bool,
}

impl Default for Features {
    fn default() -> Self {
        Self {
            cover: true,
            audio: true,
            xml: false,
            ass: false,
            nfo: false,
            srt: false,
            tools: false,
        }
    }
}

pub const FEATURE_KEYS: [&str; 7] = ["cover", "audio", "xml", "ass", "nfo", "srt", "tools"];

impl Features {
    pub fn get(&self, key: &str) -> bool {
        match key {
            "cover" => self.cover,
            "audio" => self.audio,
            "xml" => self.xml,
            "ass" => self.ass,
            "nfo" => self.nfo,
            "srt" => self.srt,
            "tools" => self.tools,
            _ => false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub directory: String,
    pub max_concurrent: u32,
    pub sound_tip: bool,
    pub shutdown: bool,
    pub listen_clipboard: bool,
    pub idle_exit_minutes: u32,
    pub tray: bool,
    pub features: Features,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_options: Option<DownloadOptions>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            directory: default_directory(),
            max_concurrent: 2,
            sound_tip: true,
            shutdown: false,
            listen_clipboard: false,
            idle_exit_minutes: 0,
            tray: true,
            features: Features::default(),
            default_options: None,
        }
    }
}

pub fn default_directory() -> String {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join("Downloads")
        .join("Bilibili")
        .to_string_lossy()
        .into_owned()
}

fn loose_integer(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        Value::Bool(true) => Some(1.0),
        Value::Bool(false) => Some(0.0),
        _ => None,
    }
}

/// Applies a partial update, mirroring `settings(value)` in `core.mjs`.
pub fn apply(current: &Settings, patch: &Value) -> Result<Settings, String> {
    let mut next = current.clone();

    if let Some(directory) = patch.get("directory") {
        let Some(text) = directory.as_str() else {
            return Err("保存目录需要使用绝对路径，且长度不能超过 220".into());
        };
        let absolute = PathBuf::from(text).is_absolute();
        if !absolute || utf16_len(text) > 220 {
            return Err("保存目录需要使用绝对路径，且长度不能超过 220".into());
        }
        next.directory = text.to_string();
    }

    if patch.get("maxConcurrent").is_some() {
        let number = loose_integer(patch.get("maxConcurrent")).unwrap_or(f64::NAN);
        if !number.is_finite() || number.fract() != 0.0 || !(1.0..=4.0).contains(&number) {
            return Err("同时下载数量应为 1–4".into());
        }
        next.max_concurrent = number as u32;
    }

    if patch.get("idleExitMinutes").is_some() {
        let number = loose_integer(patch.get("idleExitMinutes")).unwrap_or(f64::NAN);
        if !number.is_finite() || number.fract() != 0.0 || !(0.0..=1440.0).contains(&number) {
            return Err("空闲退出时间应为 0–1440 分钟".into());
        }
        next.idle_exit_minutes = number as u32;
    }

    for key in ["soundTip", "shutdown", "listenClipboard"] {
        if let Some(value) = patch.get(key) {
            let flag = value.as_bool() == Some(true);
            match key {
                "soundTip" => next.sound_tip = flag,
                "shutdown" => next.shutdown = flag,
                _ => next.listen_clipboard = flag,
            }
        }
    }

    if let Some(value) = patch.get("tray") {
        next.tray = value.as_bool() != Some(false);
    }

    if let Some(features) = patch.get("features").and_then(Value::as_object) {
        next.features = Features {
            cover: features.get("cover").and_then(Value::as_bool) == Some(true),
            audio: features.get("audio").and_then(Value::as_bool) == Some(true),
            xml: features.get("xml").and_then(Value::as_bool) == Some(true),
            ass: features.get("ass").and_then(Value::as_bool) == Some(true),
            nfo: features.get("nfo").and_then(Value::as_bool) == Some(true),
            srt: features.get("srt").and_then(Value::as_bool) == Some(true),
            tools: features.get("tools").and_then(Value::as_bool) == Some(true),
        };
    }

    if let Some(options) = patch.get("defaultOptions") {
        next.default_options = Some(validate_options(options)?);
    }

    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_match_the_node_implementation() {
        let settings = Settings::default();
        assert_eq!(settings.max_concurrent, 2);
        assert!(settings.sound_tip);
        assert!(!settings.shutdown);
        assert!(settings.tray);
        assert!(settings.features.cover && settings.features.audio);
        assert!(!settings.features.tools);
        assert!(settings.directory.ends_with("Bilibili"));
    }

    #[test]
    fn partial_updates_keep_untouched_values() {
        let current = Settings {
            directory: "D:\\Media".into(),
            ..Default::default()
        };
        let next = apply(&current, &json!({ "maxConcurrent": 4 })).unwrap();
        assert_eq!(next.directory, "D:\\Media");
        assert_eq!(next.max_concurrent, 4);
        assert!(next.sound_tip);
    }

    #[test]
    fn features_are_replaced_as_a_whole_like_javascript_spread() {
        let current = Settings::default();
        let next = apply(&current, &json!({ "features": { "tools": true } })).unwrap();
        assert!(next.features.tools);
        assert!(
            !next.features.cover,
            "absent keys become false, matching core.mjs"
        );
    }

    #[test]
    fn invalid_values_produce_the_contract_messages() {
        let current = Settings::default();
        assert_eq!(
            apply(&current, &json!({ "directory": "relative" })).unwrap_err(),
            "保存目录需要使用绝对路径，且长度不能超过 220"
        );
        assert_eq!(
            apply(&current, &json!({ "maxConcurrent": 5 })).unwrap_err(),
            "同时下载数量应为 1–4"
        );
        assert_eq!(
            apply(&current, &json!({ "idleExitMinutes": -1 })).unwrap_err(),
            "空闲退出时间应为 0–1440 分钟"
        );
    }
}
