//! Queue worker: downloads prepared streams, remuxes them and records artifacts.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use bewly_core::formats::output_location;
use bewly_core::naming::{AudioStream, Streams, VideoStream};
use bewly_engine::transfer::{self, Request};
use serde_json::{json, Value};

use crate::server::ServiceState;
use crate::tasks;

/// Bilibili CDN nodes cap each connection, so the video stream opens more of
/// them; audio is small and keeps four.
const VIDEO_CONNECTIONS: usize = 8;

/// Extension and suffix rules, copied from `core.mjs` so the on-disk names match.
pub fn extension_for(
    kind: &str,
    lossless: bool,
    dolby: bool,
    quality: u32,
    multiple_media: bool,
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
    let suffix = match kind {
        "silent" => ".video",
        "audio" if multiple_media => ".audio",
        _ => "",
    };
    (extension, suffix)
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
            // On desktop, unresolved tasks wait for a logged-in session cookie so
            // quality does not silently drop; on Android there is no browser
            // extension to pre-prepare streams, so allow guest buvid fallback.
            let allow_unresolved = cfg!(target_os = "android")
                || !state
                    .cookie
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .trim()
                    .is_empty();
            let candidate = state
                .store()
                .next_runnable_queued_task(allow_unresolved)
                .unwrap_or(None)
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
                if let Err(error) = run(&worker_state, &id, cancel) {
                    fail_unfinished(&worker_state, &id, &error);
                }
                worker_state
                    .running
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&id);
            });
        }
    });
}

/// A run that bails out with an error leaves the task where it was. A task
/// still marked queued would be picked again every tick and hold up the queue,
/// so any unfinished state becomes a visible failure.
fn fail_unfinished(state: &ServiceState, id: &str, error: &str) {
    let Ok(Some(mut task)) = state.store().task(id) else {
        return;
    };
    let status = task.get("status").and_then(Value::as_str).unwrap_or("");
    if matches!(
        status,
        "queued" | "resolving" | "downloading" | "muxing" | "postprocessing"
    ) {
        fail(state, &mut task, error);
    }
}

/// True once pause or cancel has been requested for the run that currently
/// owns `id`.
fn run_cancelled(state: &ServiceState, id: &str) -> bool {
    state
        .running
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(id)
        .is_some_and(|flag| flag.load(Ordering::Relaxed))
}

fn apply_changes(task: &mut Value, changes: Value) {
    if let (Some(target), Some(source)) = (task.as_object_mut(), changes.as_object()) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn update(state: &ServiceState, task: &mut Value, changes: Value) {
    apply_changes(task, changes);
    let id = task
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    // `task_action` raises the run's flag and rewrites the status under this
    // same store lock. A run that was told to stop no longer owns the record:
    // its copy is stale, and writing it would undo the pause or cancel, or a
    // resume that arrived while the run was still draining.
    let store = state.store();
    if run_cancelled(state, &id) {
        return;
    }
    let _ = store.put_task(task);
}

/// Moves the run into muxing or attachment saving, which pause and cancel
/// refuse to interrupt. The flag check and the write share the store lock with
/// `task_action`, so a pause is either seen here or told to wait; it is never
/// accepted and then lost.
fn commit_stage(
    state: &ServiceState,
    task: &mut Value,
    cancel: &AtomicBool,
    changes: Value,
) -> bool {
    let store = state.store();
    if cancel.load(Ordering::Relaxed) {
        return false;
    }
    apply_changes(task, changes);
    let _ = store.put_task(task);
    true
}

fn fail(state: &ServiceState, task: &mut Value, message: &str) {
    update(
        state,
        task,
        json!({ "status": "failed", "speed": 0, "error": message }),
    );
    state.save_snapshot();
}

pub fn stream_from_prepared_video(video: &Value) -> Option<VideoStream> {
    if video.is_null() || !video.is_object() {
        return None;
    }
    let quality = tasks::whole_number(video.get("quality")).unwrap_or(0) as u32;
    let codec_num = tasks::whole_number(video.get("codecid"))
        .or_else(|| tasks::whole_number(video.get("codec")))
        .or_else(|| {
            video
                .get("codec")
                .and_then(Value::as_str)
                .and_then(|s| match s {
                    "avc" | "avc1" => Some(7),
                    "hevc" | "hev1" | "hvc1" => Some(12),
                    "av1" | "av01" => Some(13),
                    other => other.parse::<u64>().ok(),
                })
        })
        .unwrap_or(0) as u32;
    let codecs = video
        .get("codecs")
        .and_then(Value::as_str)
        .or_else(|| video.get("codec").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();
    let bandwidth = video
        .get("bandwidth")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let urls: Vec<String> = video
        .get("urls")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|u| u.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if quality == 0 && urls.is_empty() {
        return None;
    }
    Some(VideoStream {
        quality,
        codec: codec_num,
        codecs,
        bandwidth,
        urls,
    })
}

pub fn stream_from_prepared_audio(audio: &Value) -> Option<AudioStream> {
    if audio.is_null() || !audio.is_object() {
        return None;
    }
    let id = tasks::whole_number(audio.get("id")).unwrap_or(0) as u32;
    let codecs = audio
        .get("codecs")
        .and_then(Value::as_str)
        .or_else(|| audio.get("codec").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();
    let bandwidth = audio
        .get("bandwidth")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let urls: Vec<String> = audio
        .get("urls")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|u| u.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if id == 0 && urls.is_empty() {
        return None;
    }
    Some(AudioStream {
        id,
        codecs,
        bandwidth,
        urls,
    })
}

/// Compares a stream id or quality numerically: the extension's payload and a
/// Rust re-resolve can encode the same id as 80.0 and 80.
fn spec_changed(old: Option<&Value>, new: Option<&Value>) -> bool {
    tasks::whole_number(old) != tasks::whole_number(new)
}

pub fn streams_from_prepared(prepared: &Value) -> Streams {
    Streams {
        video: stream_from_prepared_video(prepared.get("video").unwrap_or(&Value::Null)),
        audio: stream_from_prepared_audio(prepared.get("audio").unwrap_or(&Value::Null)),
    }
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
    let progress_cancel = Arc::clone(cancel);
    let task_id = task
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let progress_task_id = task_id.clone();

    let mut last_tick = std::time::Instant::now();
    let mut last_bytes = 0u64;
    let mut last_write = std::time::Instant::now()
        .checked_sub(std::time::Duration::from_millis(200))
        .unwrap_or_else(std::time::Instant::now);
    let mut initialized = false;
    let mut current_speed = 0u64;
    let mut last_percent = u32::MAX;
    let mut last_speed = u64::MAX;

    let result = transfer::download(
        Request {
            urls: &urls,
            destination: &destination,
            piece_length: transfer::PIECE_LENGTH,
            connections: VIDEO_CONNECTIONS,
            headers: vec![
                ("User-Agent".into(), bewly_core::ids::USER_AGENT.to_string()),
                ("Referer".into(), "https://www.bilibili.com/".into()),
            ],
        },
        Arc::clone(cancel),
        move |completed, total| {
            let now = std::time::Instant::now();
            if !initialized {
                initialized = true;
                last_tick = now;
                last_bytes = completed;
            } else {
                let elapsed = now.duration_since(last_tick).as_secs_f64();
                if elapsed >= 0.15 {
                    let delta = completed.saturating_sub(last_bytes);
                    current_speed = (delta as f64 / elapsed) as u64;
                    last_tick = now;
                    last_bytes = completed;
                }
            }

            let is_complete = completed >= total && total > 0;
            if is_complete || last_write.elapsed() >= std::time::Duration::from_millis(150) {
                if progress_cancel.load(Ordering::Relaxed) {
                    return;
                }
                last_write = now;
                let speed = if is_complete { 0 } else { current_speed };
                let percent = (completed * 100).checked_div(total).unwrap_or(0) as u32;

                if !is_complete && percent == last_percent && speed == last_speed {
                    return;
                }
                last_percent = percent;
                last_speed = speed;

                let updated = {
                    let store = state_progress.store();
                    store
                        .update_task_progress(&progress_task_id, percent, speed)
                        .unwrap_or(false)
                };
                if updated {
                    let _ =
                        state_progress.save_snapshot_throttled(std::time::Duration::from_secs(3));
                }
            }
        },
    );

    if let Ok(Some(latest)) = state.store().task(&task_id) {
        *task = latest;
    }

    match result {
        Ok(path) => Ok(Some(path)),
        Err(bewly_engine::transfer::EngineError::Cancelled) => Err("下载已取消".into()),
        Err(error) => Err(error.to_string()),
    }
}

struct StreamProgressState {
    last_tick: std::time::Instant,
    last_bytes: u64,
    last_write: std::time::Instant,
    current_speed: u64,
    initialized: bool,
    last_percent: u32,
    last_speed: u64,
}

fn pick_stream_error(
    v_res: &Result<Option<PathBuf>, String>,
    a_res: &Result<Option<PathBuf>, String>,
) -> Option<String> {
    let v_err = v_res.as_ref().err();
    let a_err = a_res.as_ref().err();

    if let Some(err) = v_err {
        if err != "下载已取消" {
            return Some(err.clone());
        }
    }
    if let Some(err) = a_err {
        if err != "下载已取消" {
            return Some(err.clone());
        }
    }

    if let Some(err) = v_err {
        return Some(err.clone());
    }
    if let Some(err) = a_err {
        return Some(err.clone());
    }

    None
}

fn download_parallel_streams(
    state: &Arc<ServiceState>,
    task: &mut Value,
    cancel: &Arc<AtomicBool>,
    video_stream: &Value,
    audio_stream: &Value,
    workdir: &std::path::Path,
) -> (
    Result<Option<PathBuf>, String>,
    Result<Option<PathBuf>, String>,
) {
    let video_urls: Vec<String> = video_stream
        .get("urls")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    let audio_urls: Vec<String> = audio_stream
        .get("urls")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    if video_urls.is_empty() {
        let audio_res = download_stream(
            state,
            task,
            cancel,
            "audio",
            audio_stream,
            workdir,
            "audio.m4a",
        );
        return (Ok(None), audio_res);
    }
    if audio_urls.is_empty() {
        let video_res = download_stream(
            state,
            task,
            cancel,
            "video",
            video_stream,
            workdir,
            "video.m4s",
        );
        return (video_res, Ok(None));
    }

    update(state, task, json!({ "stage": "video" }));

    let video_destination = workdir.join("video.m4s");
    let audio_destination = workdir.join("audio.m4a");

    let video_downloaded = Arc::new(AtomicU64::new(0));
    let video_total = Arc::new(AtomicU64::new(0));
    let audio_downloaded = Arc::new(AtomicU64::new(0));
    let audio_total = Arc::new(AtomicU64::new(0));

    let task_id = task
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let throttle = Arc::new(std::sync::Mutex::new(StreamProgressState {
        last_tick: std::time::Instant::now(),
        last_bytes: 0,
        last_write: std::time::Instant::now()
            .checked_sub(std::time::Duration::from_millis(200))
            .unwrap_or_else(std::time::Instant::now),
        current_speed: 0,
        initialized: false,
        last_percent: u32::MAX,
        last_speed: u64::MAX,
    }));

    let parallel_cancel = Arc::new(AtomicBool::new(false));

    let make_progress = |is_video: bool| {
        let state_progress = Arc::clone(state);
        let progress_task_id = task_id.clone();
        let p_cancel = Arc::clone(cancel);
        let p_parallel = Arc::clone(&parallel_cancel);
        let v_down = Arc::clone(&video_downloaded);
        let v_tot = Arc::clone(&video_total);
        let a_down = Arc::clone(&audio_downloaded);
        let a_tot = Arc::clone(&audio_total);
        let throttle_mutex = Arc::clone(&throttle);

        move |completed: u64, total: u64| {
            if is_video {
                v_down.store(completed, Ordering::Relaxed);
                v_tot.store(total, Ordering::Relaxed);
            } else {
                a_down.store(completed, Ordering::Relaxed);
                a_tot.store(total, Ordering::Relaxed);
            }

            let cur_v_down = v_down.load(Ordering::Relaxed);
            let cur_v_tot = v_tot.load(Ordering::Relaxed);
            let cur_a_down = a_down.load(Ordering::Relaxed);
            let cur_a_tot = a_tot.load(Ordering::Relaxed);

            let total_completed = cur_v_down + cur_a_down;
            let total_expected = cur_v_tot + cur_a_tot;

            let now = std::time::Instant::now();
            let mut t = match throttle_mutex.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };

            if !t.initialized {
                t.initialized = true;
                t.last_tick = now;
                t.last_bytes = total_completed;
            } else {
                let elapsed = now.duration_since(t.last_tick).as_secs_f64();
                if elapsed >= 0.15 {
                    let delta = total_completed.saturating_sub(t.last_bytes);
                    t.current_speed = (delta as f64 / elapsed) as u64;
                    t.last_tick = now;
                    t.last_bytes = total_completed;
                }
            }

            let is_complete = total_completed >= total_expected && total_expected > 0;
            if is_complete || t.last_write.elapsed() >= std::time::Duration::from_millis(150) {
                if p_cancel.load(Ordering::Relaxed) || p_parallel.load(Ordering::Relaxed) {
                    return;
                }
                t.last_write = now;
                let speed = if is_complete { 0 } else { t.current_speed };
                let percent = if total_expected > 0 {
                    (total_completed * 100)
                        .checked_div(total_expected)
                        .unwrap_or(0) as u32
                } else {
                    0
                };

                if !is_complete && percent == t.last_percent && speed == t.last_speed {
                    return;
                }
                t.last_percent = percent;
                t.last_speed = speed;
                drop(t);

                let updated = {
                    let store = state_progress.store();
                    store
                        .update_task_progress(&progress_task_id, percent, speed)
                        .unwrap_or(false)
                };
                if updated {
                    let _ =
                        state_progress.save_snapshot_throttled(std::time::Duration::from_secs(3));
                }
            }
        }
    };

    let video_progress = make_progress(true);
    let audio_progress = make_progress(false);

    let v_cancel = Arc::clone(&parallel_cancel);
    let a_cancel = Arc::clone(&parallel_cancel);

    let (video_result, audio_result) = std::thread::scope(|s| {
        let watcher_parent = Arc::clone(cancel);
        let watcher_parallel = Arc::clone(&parallel_cancel);
        s.spawn(move || {
            while !watcher_parallel.load(Ordering::Relaxed) {
                if watcher_parent.load(Ordering::Relaxed) {
                    watcher_parallel.store(true, Ordering::Relaxed);
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        });

        let v_abort = Arc::clone(&parallel_cancel);
        let v_handle = s.spawn(move || {
            let res = transfer::download(
                Request {
                    urls: &video_urls,
                    destination: &video_destination,
                    piece_length: transfer::PIECE_LENGTH,
                    connections: VIDEO_CONNECTIONS,
                    headers: vec![
                        ("User-Agent".into(), bewly_core::ids::USER_AGENT.to_string()),
                        ("Referer".into(), "https://www.bilibili.com/".into()),
                    ],
                },
                v_cancel,
                video_progress,
            );
            if res.is_err() {
                v_abort.store(true, Ordering::Relaxed);
            }
            res
        });

        let a_abort = Arc::clone(&parallel_cancel);
        let a_handle = s.spawn(move || {
            let res = transfer::download(
                Request {
                    urls: &audio_urls,
                    destination: &audio_destination,
                    piece_length: transfer::PIECE_LENGTH,
                    connections: 4,
                    headers: vec![
                        ("User-Agent".into(), bewly_core::ids::USER_AGENT.to_string()),
                        ("Referer".into(), "https://www.bilibili.com/".into()),
                    ],
                },
                a_cancel,
                audio_progress,
            );
            if res.is_err() {
                a_abort.store(true, Ordering::Relaxed);
            }
            res
        });

        let v_res = v_handle
            .join()
            .unwrap_or(Err(transfer::EngineError::Http("视频下载线程崩溃".into())));
        let a_res = a_handle
            .join()
            .unwrap_or(Err(transfer::EngineError::Http("音频下载线程崩溃".into())));
        parallel_cancel.store(true, Ordering::Relaxed);
        (v_res, a_res)
    });

    if let Ok(Some(latest)) = state.store().task(&task_id) {
        *task = latest;
    }

    let map_err = |res: Result<PathBuf, transfer::EngineError>| -> Result<Option<PathBuf>, String> {
        match res {
            Ok(path) => Ok(Some(path)),
            Err(transfer::EngineError::Cancelled) => Err("下载已取消".into()),
            Err(error) => Err(error.to_string()),
        }
    };

    (map_err(video_result), map_err(audio_result))
}

fn run(state: &Arc<ServiceState>, id: &str, cancel: Arc<AtomicBool>) -> Result<(), String> {
    state
        .policy
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .started(id);
    let Some(mut task) = state.store().task(id).map_err(|error| error.to_string())? else {
        return Ok(());
    };
    if task.get("status").and_then(Value::as_str) != Some("queued") {
        return Ok(());
    }

    let handle_cancel = |task: &mut Value| -> Result<(), String> {
        // Pause and cancel already wrote the status they meant, and the user may
        // have resumed since: `queued` means a new run is waiting for this one to
        // leave `running`, so it must be left alone. Only a status that belongs
        // to a live run is repaired.
        let latest = state.store().task(id).ok().flatten();
        if let Some(mut latest) = latest {
            let status = latest.get("status").and_then(Value::as_str).unwrap_or("");
            if matches!(status, "resolving" | "downloading") {
                latest["status"] = Value::String("paused".into());
                latest["speed"] = json!(0);
                let _ = state.store().put_task(&latest);
            }
            *task = latest;
        }
        state.save_snapshot();
        Ok(())
    };

    if cancel.load(Ordering::Relaxed) {
        return handle_cancel(&mut task);
    }

    let options =
        match bewly_core::formats::validate_options(task.get("options").unwrap_or(&json!({}))) {
            Ok(options) => options,
            Err(error) => {
                fail(state, &mut task, &error);
                return Ok(());
            }
        };

    let need_video = options
        .outputs
        .iter()
        .any(|kind| kind == "video" || kind == "silent");
    let need_audio = options
        .outputs
        .iter()
        .any(|kind| kind == "video" || kind == "audio" || kind == "mp3");

    let workdir = state.data_directory.join("partial").join(id);
    std::fs::create_dir_all(&workdir).map_err(|error| error.to_string())?;

    let mut prepared = task.get("prepared").cloned().unwrap_or(Value::Null);

    let cookie = state
        .cookie
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let has_cookie = !cookie.trim().is_empty();

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let prepared_at = prepared
        .get("preparedAt")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let expired = prepared_at > 0 && now_ms.saturating_sub(prepared_at) >= 20 * 60_000;

    if (need_video || need_audio) && (prepared.is_null() || (expired && has_cookie)) {
        update(
            state,
            &mut task,
            json!({ "status": "resolving", "speed": 0 }),
        );
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
                update(state, &mut task, json!({ "prepared": value.clone() }));
                prepared = value;
            }
            Err(error) => {
                fail(state, &mut task, &error);
                return Ok(());
            }
        }
    }

    if cancel.load(Ordering::Relaxed) {
        return handle_cancel(&mut task);
    }

    let prev_quality = task.get("actualQuality");
    let prev_codec = task.get("actualCodec");
    let prev_audio_id = task.get("actualAudioId");

    let curr_quality = prepared.get("video").and_then(|v| v.get("quality"));
    let curr_codec = prepared.get("video").and_then(|v| v.get("codec"));
    let curr_audio_id = prepared.get("audio").and_then(|a| a.get("id"));

    let has_quality_mismatch = prev_quality
        .map(|v| !v.is_null() && spec_changed(Some(v), curr_quality))
        .unwrap_or(false);
    let has_codec_mismatch = prev_codec
        .map(|v| !v.is_null() && spec_changed(Some(v), curr_codec))
        .unwrap_or(false);
    let has_audio_mismatch = prev_audio_id
        .map(|v| !v.is_null() && spec_changed(Some(v), curr_audio_id))
        .unwrap_or(false);

    if has_quality_mismatch || has_codec_mismatch || has_audio_mismatch {
        for file_name in &[
            "video.m4s",
            "video.m4s.aria2",
            "video.m4s.bewly.json",
            "audio.m4a",
            "audio.m4a.aria2",
            "audio.m4a.bewly.json",
        ] {
            let _ = std::fs::remove_file(workdir.join(file_name));
        }
    }

    let current_progress = task.get("progress").and_then(Value::as_u64).unwrap_or(0);
    update(
        state,
        &mut task,
        json!({
            "status": "downloading",
            "progress": current_progress,
            "speed": 0,
            "error": "",
            "actualQuality": curr_quality,
            "actualCodec": curr_codec,
            "actualAudioId": curr_audio_id,
        }),
    );
    state.save_snapshot();

    let mut refreshed = false;

    let (video, audio) = if need_video && need_audio {
        let (mut v_res, mut a_res) = download_parallel_streams(
            state,
            &mut task,
            &cancel,
            &prepared["video"],
            &prepared["audio"],
            &workdir,
        );
        let err_opt = pick_stream_error(&v_res, &a_res);
        if let Some(ref err) = err_opt {
            let cookie = state
                .cookie
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone();
            if !cancel.load(Ordering::Relaxed)
                && err != "下载已取消"
                && !err.contains("磁盘空间不足")
                && !refreshed
                && !cookie.trim().is_empty()
            {
                refreshed = true;
                let _ = refreshed;
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
                    Ok(new_prepared) => {
                        let q_old = prepared.get("video").and_then(|v| v.get("quality"));
                        let q_new = new_prepared.get("video").and_then(|v| v.get("quality"));
                        let c_old = prepared.get("video").and_then(|v| v.get("codec"));
                        let c_new = new_prepared.get("video").and_then(|v| v.get("codec"));
                        let a_old = prepared.get("audio").and_then(|a| a.get("id"));
                        let a_new = new_prepared.get("audio").and_then(|a| a.get("id"));
                        if spec_changed(q_old, q_new)
                            || spec_changed(c_old, c_new)
                            || spec_changed(a_old, a_new)
                        {
                            fail(state, &mut task, "媒体规格已变化，请重新添加任务");
                            return Ok(());
                        }
                        update(
                            state,
                            &mut task,
                            json!({ "prepared": new_prepared.clone() }),
                        );
                        prepared = new_prepared;
                        let retry_res = download_parallel_streams(
                            state,
                            &mut task,
                            &cancel,
                            &prepared["video"],
                            &prepared["audio"],
                            &workdir,
                        );
                        v_res = retry_res.0;
                        a_res = retry_res.1;
                    }
                    Err(e) => {
                        fail(state, &mut task, &e);
                        return Ok(());
                    }
                }
            }
        }
        if let Some(err) = pick_stream_error(&v_res, &a_res) {
            if cancel.load(Ordering::Relaxed) || err == "下载已取消" {
                return handle_cancel(&mut task);
            }
            fail(state, &mut task, &err);
            return Ok(());
        }
        let v_path = v_res.unwrap_or(None);
        let a_path = a_res.unwrap_or(None);
        (v_path, a_path)
    } else {
        let video = if need_video {
            let mut res = download_stream(
                state,
                &mut task,
                &cancel,
                "video",
                &prepared["video"],
                &workdir,
                "video.m4s",
            );
            if let Err(ref err) = res {
                let cookie = state
                    .cookie
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone();
                if !cancel.load(Ordering::Relaxed)
                    && err != "下载已取消"
                    && !err.contains("磁盘空间不足")
                    && !refreshed
                    && !cookie.trim().is_empty()
                {
                    refreshed = true;
                    let _ = refreshed;
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
                        Ok(new_prepared) => {
                            let q_old = prepared.get("video").and_then(|v| v.get("quality"));
                            let q_new = new_prepared.get("video").and_then(|v| v.get("quality"));
                            let c_old = prepared.get("video").and_then(|v| v.get("codec"));
                            let c_new = new_prepared.get("video").and_then(|v| v.get("codec"));
                            let a_old = prepared.get("audio").and_then(|a| a.get("id"));
                            let a_new = new_prepared.get("audio").and_then(|a| a.get("id"));
                            if spec_changed(q_old, q_new)
                                || spec_changed(c_old, c_new)
                                || spec_changed(a_old, a_new)
                            {
                                fail(state, &mut task, "媒体规格已变化，请重新添加任务");
                                return Ok(());
                            }
                            update(
                                state,
                                &mut task,
                                json!({ "prepared": new_prepared.clone() }),
                            );
                            prepared = new_prepared;
                            res = download_stream(
                                state,
                                &mut task,
                                &cancel,
                                "video",
                                &prepared["video"],
                                &workdir,
                                "video.m4s",
                            );
                        }
                        Err(e) => {
                            fail(state, &mut task, &e);
                            return Ok(());
                        }
                    }
                }
            }
            match res {
                Ok(path) => path,
                Err(err) => {
                    if cancel.load(Ordering::Relaxed) || err == "下载已取消" {
                        return handle_cancel(&mut task);
                    }
                    fail(state, &mut task, &err);
                    return Ok(());
                }
            }
        } else {
            None
        };
        if cancel.load(Ordering::Relaxed) {
            return handle_cancel(&mut task);
        }
        if need_video && video.is_none() {
            fail(state, &mut task, "没有所选视频流");
            return Ok(());
        }

        let audio = if need_audio {
            let mut res = download_stream(
                state,
                &mut task,
                &cancel,
                "audio",
                &prepared["audio"],
                &workdir,
                "audio.m4a",
            );
            if let Err(ref err) = res {
                let cookie = state
                    .cookie
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone();
                if !cancel.load(Ordering::Relaxed)
                    && err != "下载已取消"
                    && !err.contains("磁盘空间不足")
                    && !refreshed
                    && !cookie.trim().is_empty()
                {
                    refreshed = true;
                    let _ = refreshed;
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
                        Ok(new_prepared) => {
                            let q_old = prepared.get("video").and_then(|v| v.get("quality"));
                            let q_new = new_prepared.get("video").and_then(|v| v.get("quality"));
                            let c_old = prepared.get("video").and_then(|v| v.get("codec"));
                            let c_new = new_prepared.get("video").and_then(|v| v.get("codec"));
                            let a_old = prepared.get("audio").and_then(|a| a.get("id"));
                            let a_new = new_prepared.get("audio").and_then(|a| a.get("id"));
                            if spec_changed(q_old, q_new)
                                || spec_changed(c_old, c_new)
                                || spec_changed(a_old, a_new)
                            {
                                fail(state, &mut task, "媒体规格已变化，请重新添加任务");
                                return Ok(());
                            }
                            update(
                                state,
                                &mut task,
                                json!({ "prepared": new_prepared.clone() }),
                            );
                            prepared = new_prepared;
                            res = download_stream(
                                state,
                                &mut task,
                                &cancel,
                                "audio",
                                &prepared["audio"],
                                &workdir,
                                "audio.m4a",
                            );
                        }
                        Err(e) => {
                            fail(state, &mut task, &e);
                            return Ok(());
                        }
                    }
                }
            }
            match res {
                Ok(path) => path,
                Err(err) => {
                    if cancel.load(Ordering::Relaxed) || err == "下载已取消" {
                        return handle_cancel(&mut task);
                    }
                    fail(state, &mut task, &err);
                    return Ok(());
                }
            }
        } else {
            None
        };
        (video, audio)
    };
    if cancel.load(Ordering::Relaxed) {
        return handle_cancel(&mut task);
    }
    let has_audio_stream = !prepared["audio"].is_null() && prepared["audio"].is_object();
    let need_separate_audio = options
        .outputs
        .iter()
        .any(|k| matches!(k.as_str(), "audio" | "mp3"))
        || has_audio_stream;
    // A combined file without a separate audio stream is handled at output time.
    let combined_file = !has_audio_stream && video.is_some();
    if need_separate_audio && audio.is_none() && !combined_file {
        fail(state, &mut task, "没有所选音频流");
        return Ok(());
    }

    let media_kinds: Vec<&str> = options
        .outputs
        .iter()
        .filter(|k| matches!(k.as_str(), "video" | "silent" | "audio" | "mp3"))
        .map(|s| s.as_str())
        .collect();
    let multiple_media = media_kinds.len() > 1;

    let view = tasks::view_of(&task, &state.settings().directory);
    let streams = streams_from_prepared(&prepared);
    let (directory, basename) = match output_location(&view, &streams) {
        Ok(location) => location,
        Err(error) => {
            fail(state, &mut task, &error);
            return Ok(());
        }
    };
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    // "Auto" audio quality can pick the FLAC or Dolby track, so the container
    // follows the stream actually downloaded: FFmpeg refuses FLAC in MP4.
    let audio_id = tasks::whole_number(prepared["audio"].get("id"));
    let audio_codecs = prepared["audio"]
        .get("codecs")
        .and_then(Value::as_str)
        .unwrap_or("");
    let lossless = audio_id == Some(30251)
        || audio_codecs.eq_ignore_ascii_case("flac")
        || options.audio_quality == "hires";
    let dolby = audio_id == Some(30250)
        || audio_codecs.eq_ignore_ascii_case("ec-3")
        || options.audio_quality == "dolby";
    let quality = tasks::whole_number(prepared["video"].get("quality")).unwrap_or(0) as u32;

    let mut artifacts = serde_json::Map::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut output: Option<String> = None;

    // A combined (durl) file carries its own audio track; without this the
    // video output would map only the picture and audio outputs would fail.
    let embedded_audio = audio.is_none() && prepared["audio"].is_null() && video.is_some();
    let audio_input = if embedded_audio {
        video.as_deref()
    } else {
        audio.as_deref()
    };

    if !media_kinds.is_empty() {
        if !commit_stage(
            state,
            &mut task,
            &cancel,
            json!({ "status": "muxing", "progress": 100, "speed": 0 }),
        ) {
            return handle_cancel(&mut task);
        }
        for kind in media_kinds {
            let (extension, suffix) = extension_for(kind, lossless, dolby, quality, multiple_media);
            let target = directory.join(format!("{basename}{suffix}.{extension}"));
            update(state, &mut task, json!({ "stage": kind }));
            match kind {
                "mp3" => {
                    let Some(audio) = audio_input else {
                        fail(state, &mut task, "没有所选音频流");
                        return Ok(());
                    };
                    if let Err(error) = bewly_media::transcode_mp3(audio, &target) {
                        fail(state, &mut task, &error.to_string());
                        return Ok(());
                    }
                }
                "video" | "silent" | "audio" => {
                    let result = bewly_media::remux(
                        if kind == "audio" {
                            None
                        } else {
                            video.as_deref()
                        },
                        if kind == "silent" { None } else { audio_input },
                        &target,
                        extension,
                        matches!(extension, "mp4" | "m4a"),
                    );
                    if let Err(error) = result {
                        fail(state, &mut task, &error.to_string());
                        return Ok(());
                    }
                }
                _ => {}
            }
            let text = target.to_string_lossy().into_owned();
            artifacts.insert(kind.to_string(), Value::String(text.clone()));
            if output.is_none() {
                output = Some(text);
            }
        }
    }

    if !commit_stage(
        state,
        &mut task,
        &cancel,
        json!({
            "status": "postprocessing",
            "stage": "",
            "speed": 0,
            "output": output.as_deref(),
        }),
    ) {
        return handle_cancel(&mut task);
    }

    if options.outputs.iter().any(|k| k == "cover") {
        let cover = task
            .get("cover")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or(&view.cover)
            .to_string();
        if cover.is_empty() {
            warnings.push("封面：任务没有封面地址".into());
        } else {
            match crate::net::fetch_bytes(&cover) {
                Ok((bytes, content_type)) => {
                    let extension = if content_type.contains("png") {
                        "png"
                    } else if content_type.contains("webp") {
                        "webp"
                    } else {
                        "jpg"
                    };
                    let target = directory.join(format!("{basename}.{extension}"));
                    match write_atomic(&target, &bytes) {
                        Ok(()) => {
                            let text = target.to_string_lossy().into_owned();
                            artifacts.insert("cover".to_string(), Value::String(text.clone()));
                            if output.is_none() {
                                output = Some(text);
                            }
                        }
                        Err(error) => warnings.push(format!("封面：{error}")),
                    }
                }
                Err(error) => warnings.push(format!("封面：{error}")),
            }
        }
    }

    let want_xml = options.outputs.iter().any(|k| k == "xml");
    let want_ass = options.outputs.iter().any(|k| k == "ass");
    if want_xml || want_ass {
        let cid = task.get("cid").and_then(Value::as_u64).unwrap_or(0);
        match crate::net::fetch_danmaku(cid) {
            Ok(xml) => {
                if want_xml {
                    let target = directory.join(format!("{basename}.xml"));
                    match write_atomic(&target, xml.as_bytes()) {
                        Ok(()) => {
                            let text = target.to_string_lossy().into_owned();
                            artifacts.insert("xml".to_string(), Value::String(text.clone()));
                            if output.is_none() {
                                output = Some(text);
                            }
                        }
                        Err(error) => warnings.push(format!("弹幕：{error}")),
                    }
                }
                if want_ass {
                    let ass_content = bewly_core::formats::to_ass(&xml);
                    let target = directory.join(format!("{basename}.ass"));
                    match write_atomic(&target, ass_content.as_bytes()) {
                        Ok(()) => {
                            let text = target.to_string_lossy().into_owned();
                            artifacts.insert("ass".to_string(), Value::String(text.clone()));
                            if output.is_none() {
                                output = Some(text);
                            }
                        }
                        Err(error) => warnings.push(format!("弹幕：{error}")),
                    }
                }
            }
            Err(error) => warnings.push(format!("弹幕：{error}")),
        }
    }

    if options.outputs.iter().any(|k| k == "srt") {
        let bvid = task.get("bvid").and_then(Value::as_str).unwrap_or("");
        let cid = task.get("cid").and_then(Value::as_u64).unwrap_or(0);
        let prepared_tracks = prepared
            .get("subtitleTracks")
            .and_then(Value::as_array)
            .map(|a| a.as_slice());
        let cookie = state
            .cookie
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        match crate::net::fetch_subtitles(
            bvid,
            cid,
            prepared_tracks,
            &options.subtitle_languages,
            &cookie,
        ) {
            Ok(subtitles) => {
                if subtitles.is_empty() {
                    warnings.push("字幕：这个视频没有所选语言的可用字幕".into());
                } else {
                    for subtitle in subtitles {
                        let safe_lang = bewly_core::naming::safe_name(&subtitle.language);
                        let target = directory.join(format!("{basename}.{safe_lang}.srt"));
                        match write_atomic(&target, subtitle.content.as_bytes()) {
                            Ok(()) => {
                                let text = target.to_string_lossy().into_owned();
                                artifacts.insert(
                                    format!("srt-{}", subtitle.language),
                                    Value::String(text.clone()),
                                );
                                if output.is_none() {
                                    output = Some(text);
                                }
                            }
                            Err(error) => warnings.push(format!("字幕：{error}")),
                        }
                    }
                }
            }
            Err(error) => warnings.push(format!("字幕：{error}")),
        }
    }

    if options.outputs.iter().any(|k| k == "nfo") {
        let text = bewly_core::formats::to_nfo(&view);
        let target = directory.join(format!("{basename}.nfo"));
        match write_atomic(&target, text.as_bytes()) {
            Ok(()) => {
                let text = target.to_string_lossy().into_owned();
                artifacts.insert("nfo".to_string(), Value::String(text.clone()));
                if output.is_none() {
                    output = Some(text);
                }
            }
            Err(error) => warnings.push(format!("NFO：{error}")),
        }
    }

    if output.is_none() && artifacts.is_empty() {
        let message = if warnings.is_empty() {
            "没有生成任何输出文件".to_string()
        } else {
            warnings.join("；")
        };
        fail(state, &mut task, &message);
        return Ok(());
    }

    update(
        state,
        &mut task,
        json!({
            "status": "completed",
            "progress": 100,
            "speed": 0,
            "stage": "",
            "artifacts": artifacts,
            "output": output,
            "warnings": warnings,
            "prepared": Value::Null,
            "completedAt": tasks::service_now(),
        }),
    );
    state
        .policy
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .finished();
    state.save_snapshot();
    let _ = std::fs::remove_dir_all(&workdir);
    Ok(())
}

fn write_atomic(target: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = target.with_extension(format!(
        "{}.part",
        target
            .extension()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "tmp".into())
    ));
    std::fs::write(&temporary, bytes)?;
    if target.exists() {
        let _ = std::fs::remove_file(&temporary);
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "同名文件已存在，保留了原文件",
        ));
    }
    std::fs::rename(&temporary, target)
}

// Keep the map type in one place for the state definition.
pub type RunningMap = HashMap<String, Arc<AtomicBool>>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streams_from_prepared_populates_naming_tokens() {
        let prepared = json!({
            "preparedAt": 1700000000000u64,
            "video": {
                "quality": 80,
                "codec": "avc",
                "codecid": 7,
                "codecs": "avc1.640028",
                "bandwidth": 1500000.0,
                "urls": ["http://example.com/v.m4s"],
            },
            "audio": {
                "id": 30280,
                "codecs": "mp4a.40.2",
                "bandwidth": 192000.0,
                "urls": ["http://example.com/a.m4a"],
            }
        });

        let streams = streams_from_prepared(&prepared);
        assert!(streams.video.is_some());
        assert!(streams.audio.is_some());
        let v = streams.video.as_ref().unwrap();
        assert_eq!(v.quality, 80);
        assert_eq!(v.codec, 7);
        assert_eq!(v.codecs, "avc1.640028");
        let a = streams.audio.as_ref().unwrap();
        assert_eq!(a.id, 30280);
        assert_eq!(a.codecs, "mp4a.40.2");

        let task = json!({
            "id": "test-task-1",
            "title": "测试视频",
            "bvid": "BV1xx411c7mD",
            "cid": 12345,
            "filenameTemplate": "%title%_%vqn%_%aqn%",
            "options": {
                "filenameTemplate": "%title%_%vqn%_%aqn%",
            }
        });
        let view = tasks::view_of(&task, "D:/downloads");
        let (_dir, name) = output_location(&view, &streams).unwrap();
        assert!(
            name.contains("1080P"),
            "expected 1080P in name, got: {name}"
        );
        assert!(name.contains("192K"), "expected 192K in name, got: {name}");

        // Contrast with default empty streams
        let (_dir, default_name) = output_location(&view, &Streams::default()).unwrap();
        assert!(!default_name.contains("1080P"));
        assert!(!default_name.contains("192K"));
    }

    #[test]
    fn streams_from_null_or_empty_prepared_returns_none() {
        let streams = streams_from_prepared(&json!({}));
        assert!(streams.video.is_none());
        assert!(streams.audio.is_none());
    }
    #[test]
    fn float_ids_from_older_tasks_still_read_and_compare() {
        // Earlier builds stored the extension's ids as floats; the Hi-Res check
        // missed them and FLAC was remuxed into MP4.
        let streams = streams_from_prepared(&json!({
            "video": { "urls": ["https://a/v.m4s"], "quality": 80.0, "codec": 12.0 },
            "audio": { "urls": ["https://a/a.m4s"], "id": 30251.0 },
        }));
        assert_eq!(streams.video.unwrap().quality, 80);
        assert_eq!(streams.audio.unwrap().id, 30251);
        assert!(!spec_changed(Some(&json!(80.0)), Some(&json!(80))));
        assert!(spec_changed(Some(&json!(80)), Some(&json!(64))));
        assert!(!spec_changed(None, None));
    }
    #[test]
    fn extensions_follow_the_node_rules() {
        assert_eq!(extension_for("video", false, false, 80, false), ("mp4", ""));
        assert_eq!(extension_for("video", true, false, 80, false), ("mkv", ""));
        assert_eq!(extension_for("video", false, true, 80, false), ("mkv", ""));
        assert_eq!(
            extension_for("video", false, false, 126, false),
            ("mkv", "")
        );
        assert_eq!(
            extension_for("silent", false, false, 80, false),
            ("mp4", ".video")
        );
        assert_eq!(extension_for("audio", false, false, 80, false), ("m4a", ""));
        assert_eq!(
            extension_for("audio", false, false, 80, true),
            ("m4a", ".audio")
        );
        assert_eq!(extension_for("audio", true, false, 80, false), ("flac", ""));
        assert_eq!(
            extension_for("audio", true, false, 80, true),
            ("flac", ".audio")
        );
        assert_eq!(extension_for("audio", false, true, 80, false), ("mka", ""));
        assert_eq!(
            extension_for("audio", false, true, 80, true),
            ("mka", ".audio")
        );
    }

    #[test]
    fn pick_stream_error_prioritizes_real_error_over_cancelled() {
        let real_err: Result<Option<PathBuf>, String> = Err("HTTP 403 Forbidden".into());
        let cancel_err: Result<Option<PathBuf>, String> = Err("下载已取消".into());
        let ok_res: Result<Option<PathBuf>, String> = Ok(Some(PathBuf::from("/path/test")));
        let none_res: Result<Option<PathBuf>, String> = Ok(None);

        // Audio fails with real error, video cancelled
        assert_eq!(
            pick_stream_error(&cancel_err, &real_err),
            Some("HTTP 403 Forbidden".into())
        );

        // Video fails with real error, audio cancelled
        assert_eq!(
            pick_stream_error(&real_err, &cancel_err),
            Some("HTTP 403 Forbidden".into())
        );

        // Both cancelled
        assert_eq!(
            pick_stream_error(&cancel_err, &cancel_err),
            Some("下载已取消".into())
        );

        // One cancelled, other Ok
        assert_eq!(
            pick_stream_error(&cancel_err, &ok_res),
            Some("下载已取消".into())
        );
        assert_eq!(
            pick_stream_error(&ok_res, &cancel_err),
            Some("下载已取消".into())
        );

        // Both Ok
        assert_eq!(pick_stream_error(&ok_res, &none_res), None);
    }
}
