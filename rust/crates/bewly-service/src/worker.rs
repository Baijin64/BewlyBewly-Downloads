//! Queue worker: downloads prepared streams, remuxes them and records artifacts.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use bewly_core::formats::output_location;
use bewly_core::naming::Streams;
use bewly_engine::transfer::{self, Request};
use serde_json::{json, Value};

use crate::server::ServiceState;
use crate::tasks;

/// Extension and suffix rules, copied from `core.mjs` so the on-disk names match.
pub fn extension_for(
    kind: &str,
    lossless: bool,
    dolby: bool,
    quality: u32,
) -> (&'static str, &'static str) {
    let extension = match kind {
        "mp3" => "mp3",
        "audio" => {
            if lossless {
                "flac"
            } else if dolby {
                "mka"
            } else {
                "m4a"
            }
        }
        _ => {
            if lossless || dolby || quality == 126 {
                "mkv"
            } else {
                "mp4"
            }
        }
    };
    (extension, if kind == "silent" { ".video" } else { "" })
}

pub fn spawn(state: Arc<ServiceState>) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_millis(500));
        loop {
            ticker.tick().await;
            if state.closing.load(Ordering::Relaxed) {
                continue;
            }
            let settings = state.settings();
            let running = state
                .running
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .len();
            if running >= settings.max_concurrent as usize {
                continue;
            }
            let candidate = state
                .tasks()
                .into_iter()
                .rev()
                .find(|task| {
                    if task.get("status").and_then(Value::as_str) != Some("queued") {
                        return false;
                    }
                    let prepared = task
                        .get("prepared")
                        .map(|value| !value.is_null())
                        .unwrap_or(false);
                    // Without a session cookie playurl cannot be signed, so the task
                    // waits instead of failing with an authentication error.
                    prepared
                        || !state
                            .cookie
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .is_empty()
                })
                .and_then(|task| task.get("id").and_then(Value::as_str).map(str::to_string));
            let Some(id) = candidate else {
                continue;
            };
            let cancel = Arc::new(AtomicBool::new(false));
            {
                let mut running = state.running.lock().unwrap_or_else(|p| p.into_inner());
                if running.contains_key(&id) {
                    continue;
                }
                running.insert(id.clone(), cancel.clone());
            }
            let worker_state = state.clone();
            tokio::task::spawn_blocking(move || {
                let _ = run(&worker_state, &id, cancel);
                worker_state
                    .running
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&id);
            });
        }
    });
}

fn update(state: &ServiceState, task: &mut Value, changes: Value) {
    if let (Some(target), Some(source)) = (task.as_object_mut(), changes.as_object()) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
    let _ = state.store().put_task(task);
}

fn fail(state: &ServiceState, task: &mut Value, message: &str) {
    update(
        state,
        task,
        json!({ "status": "failed", "speed": 0, "error": message }),
    );
    state.save_snapshot();
}

fn download_stream(
    state: &Arc<ServiceState>,
    task: &mut Value,
    cancel: &Arc<AtomicBool>,
    label: &str,
    stream: &Value,
    workdir: &std::path::Path,
    file_name: &str,
) -> Result<Option<PathBuf>, String> {
    let urls: Vec<String> = stream
        .get("urls")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if urls.is_empty() {
        return Ok(None);
    }
    let destination = workdir.join(file_name);
    update(state, task, json!({ "stage": label }));
    let state_progress = Arc::clone(state);
    let task_id = task
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let result = transfer::download(
        Request {
            urls: &urls,
            destination: &destination,
            piece_length: transfer::PIECE_LENGTH,
            connections: 4,
            headers: vec![
                ("User-Agent".into(), bewly_core::ids::USER_AGENT.to_string()),
                ("Referer".into(), "https://www.bilibili.com/".into()),
            ],
        },
        Arc::clone(cancel),
        move |completed, total| {
            let percent = (completed * 100).checked_div(total).unwrap_or(0) as u32;
            if let Ok(Some(mut current)) = state_progress.store().task(&task_id) {
                current["progress"] = json!(percent);
                let _ = state_progress.store().put_task(&current);
            }
        },
    );
    match result {
        Ok(path) => Ok(Some(path)),
        Err(bewly_engine::transfer::EngineError::Cancelled) => Err("下载已取消".into()),
        Err(error) => Err(error.to_string()),
    }
}

fn run(state: &Arc<ServiceState>, id: &str, cancel: Arc<AtomicBool>) -> Result<(), String> {
    let Some(mut task) = state.store().task(id).map_err(|error| error.to_string())? else {
        return Ok(());
    };
    update(
        state,
        &mut task,
        json!({ "status": "downloading", "progress": 0, "speed": 0, "error": "" }),
    );
    state.save_snapshot();

    let options =
        match bewly_core::formats::validate_options(task.get("options").unwrap_or(&json!({}))) {
            Ok(options) => options,
            Err(error) => {
                fail(state, &mut task, &error);
                return Ok(());
            }
        };
    let mut prepared = task.get("prepared").cloned().unwrap_or(Value::Null);
    if prepared.is_null() {
        let cookie = state
            .cookie
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let bvid = task.get("bvid").and_then(Value::as_str).unwrap_or("");
        let cid = task.get("cid").and_then(Value::as_u64).unwrap_or(0);
        match crate::net::resolve(
            bvid,
            cid,
            options.quality,
            &options.audio_quality,
            &options.outputs,
            &options.codec,
            &cookie,
        ) {
            Ok(value) => {
                task["prepared"] = value.clone();
                let _ = state.store().put_task(&task);
                prepared = value;
            }
            Err(error) => {
                fail(state, &mut task, &error);
                return Ok(());
            }
        }
    }

    let workdir = state.data_directory.join("partial").join(id);
    std::fs::create_dir_all(&workdir).map_err(|error| error.to_string())?;

    let need_video = options
        .outputs
        .iter()
        .any(|kind| kind == "video" || kind == "silent");
    let need_audio = options
        .outputs
        .iter()
        .any(|kind| kind == "video" || kind == "audio" || kind == "mp3");

    let video = if need_video {
        download_stream(
            state,
            &mut task,
            &cancel,
            "video",
            &prepared["video"],
            &workdir,
            "video.m4s",
        )?
    } else {
        None
    };
    if cancel.load(Ordering::Relaxed) {
        update(state, &mut task, json!({ "status": "paused", "speed": 0 }));
        return Ok(());
    }
    if need_video && video.is_none() {
        fail(state, &mut task, "没有所选视频流");
        return Ok(());
    }
    let audio = if need_audio {
        download_stream(
            state,
            &mut task,
            &cancel,
            "audio",
            &prepared["audio"],
            &workdir,
            "audio.m4a",
        )?
    } else {
        None
    };
    if cancel.load(Ordering::Relaxed) {
        update(state, &mut task, json!({ "status": "paused", "speed": 0 }));
        return Ok(());
    }
    if need_audio && audio.is_none() {
        fail(state, &mut task, "没有所选音频流");
        return Ok(());
    }

    update(
        state,
        &mut task,
        json!({ "status": "muxing", "progress": 100, "speed": 0 }),
    );
    let view = tasks::view_of(&task, &state.settings().directory);
    let (directory, basename) = match output_location(&view, &Streams::default()) {
        Ok(location) => location,
        Err(error) => {
            fail(state, &mut task, &error);
            return Ok(());
        }
    };
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let lossless = prepared["audio"].get("id").and_then(Value::as_u64) == Some(30251)
        || options.audio_quality == "hires";
    let dolby = prepared["audio"].get("id").and_then(Value::as_u64) == Some(30250)
        || options.audio_quality == "dolby";
    let quality = prepared["video"]
        .get("quality")
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;

    let mut artifacts = serde_json::Map::new();
    let mut output: Option<String> = None;
    for kind in options
        .outputs
        .iter()
        .filter(|kind| matches!(kind.as_str(), "video" | "silent" | "audio"))
    {
        let (extension, suffix) = extension_for(kind, lossless, dolby, quality);
        let target = directory.join(format!("{basename}{suffix}.{extension}"));
        update(state, &mut task, json!({ "stage": kind }));
        let result = bewly_media::remux(
            if kind == "silent" || kind == "video" {
                video.as_deref()
            } else {
                None
            },
            if kind == "silent" {
                None
            } else {
                audio.as_deref()
            },
            &target,
            extension,
            matches!(extension, "mp4" | "m4a"),
        );
        if let Err(error) = result {
            fail(state, &mut task, &error.to_string());
            return Ok(());
        }
        let text = target.to_string_lossy().into_owned();
        artifacts.insert(kind.clone(), Value::String(text.clone()));
        if output.is_none() {
            output = Some(text);
        }
    }

    update(
        state,
        &mut task,
        json!({
            "status": "completed",
            "progress": 100,
            "speed": 0,
            "artifacts": artifacts,
            "output": output,
            "completedAt": tasks::service_now(),
        }),
    );
    state.save_snapshot();
    let _ = std::fs::remove_dir_all(&workdir);
    Ok(())
}

// Keep the map type in one place for the state definition.
pub type RunningMap = HashMap<String, Arc<AtomicBool>>;

#[cfg(test)]
mod tests {
    use super::extension_for;

    #[test]
    fn extensions_follow_the_node_rules() {
        assert_eq!(extension_for("video", false, false, 80), ("mp4", ""));
        assert_eq!(extension_for("video", true, false, 80), ("mkv", ""));
        assert_eq!(extension_for("video", false, true, 80), ("mkv", ""));
        assert_eq!(extension_for("video", false, false, 126), ("mkv", ""));
        assert_eq!(extension_for("silent", false, false, 80), ("mp4", ".video"));
        assert_eq!(extension_for("audio", false, false, 80), ("m4a", ""));
        assert_eq!(extension_for("audio", true, false, 80), ("flac", ""));
        assert_eq!(extension_for("audio", false, true, 80), ("mka", ""));
    }
}
