//! Local RPC server: `POST /rpc` on loopback with bearer auth and no CORS.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State as AxumState};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use bewly_core::formats::{output_location, validate_options, DownloadOptions};
use bewly_core::naming::{Group, Streams, TaskView};
use bewly_store::Store;
use serde_json::{json, Value};
use subtle::ConstantTimeEq;

use crate::health::{health, PlatformCaps};
use crate::lifetime::{now_ms, SharedLifetime};
use crate::settings::{apply, Settings};
use crate::tasks;
use crate::tools;

pub struct ServiceState {
    pub data_directory: PathBuf,
    pub store: std::sync::Mutex<Store>,
    pub settings: RwLock<Settings>,
    pub token: String,
    pub mode: String,
    pub closing: AtomicBool,
    pub last_tray: AtomicI64,
    pub storage_error: String,
    pub caps: PlatformCaps,
    pub lifetime: SharedLifetime,
    pub active_requests: AtomicUsize,
    pub tray: std::sync::Mutex<Option<std::process::Child>>,
    pub running: std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<AtomicBool>>>,
}

impl ServiceState {
    pub fn open(data_directory: &Path, mode: &str) -> Result<Self, String> {
        std::fs::create_dir_all(data_directory).map_err(|error| error.to_string())?;
        let store = Store::open(data_directory).map_err(|error| error.to_string())?;
        let settings = match store.settings().map_err(|error| error.to_string())? {
            Some(value) => merge_settings(&Settings::default(), &value),
            None => Settings::default(),
        };
        Ok(Self {
            data_directory: data_directory.to_path_buf(),
            store: std::sync::Mutex::new(store),
            settings: RwLock::new(settings),
            token: random_token(),
            mode: mode.to_string(),
            closing: AtomicBool::new(false),
            last_tray: AtomicI64::new(0),
            storage_error: String::new(),
            caps: PlatformCaps::current(),
            lifetime: SharedLifetime::new(mode),
            active_requests: AtomicUsize::new(0),
            tray: std::sync::Mutex::new(None),
            running: std::sync::Mutex::new(std::collections::HashMap::new()),
        })
    }

    pub fn settings(&self) -> Settings {
        self.settings.read().expect("settings lock").clone()
    }

    pub fn health_value(&self) -> Value {
        health(
            &self.settings(),
            &self.storage_error,
            self.last_tray.load(Ordering::Relaxed),
            self.caps,
        )
    }

    pub fn store(&self) -> std::sync::MutexGuard<'_, Store> {
        self.store
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn tasks(&self) -> Vec<Value> {
        self.store().tasks().unwrap_or_default()
    }

    fn persist_settings(&self, settings: &Settings) -> Result<(), String> {
        let value = serde_json::to_value(settings).map_err(|error| error.to_string())?;
        self.store()
            .put_settings(&value)
            .map_err(|error| error.to_string())
    }

    /// Mirrors `lifetime.snapshot()`: busy tasks or in-flight requests suppress
    /// the idle exit, and `exitAt` is only present when an exit is pending.
    pub fn runtime(&self) -> Value {
        let busy = self
            .running
            .lock()
            .map(|map| !map.is_empty())
            .unwrap_or(false)
            || self.active_requests.load(Ordering::Relaxed) > 0
            || self.tasks().iter().any(|task| {
                matches!(
                    task.get("status").and_then(Value::as_str).unwrap_or(""),
                    "queued" | "resolving" | "downloading" | "paused" | "muxing" | "postprocessing"
                )
            });
        let idle_minutes = self.settings().idle_exit_minutes;
        let runtime = self.lifetime.lock().snapshot(busy, idle_minutes);
        let mut value = serde_json::Map::new();
        value.insert("running".into(), Value::Bool(true));
        value.insert("mode".into(), Value::String(runtime.mode));
        value.insert("state".into(), Value::String(runtime.state.into()));
        if let Some(exit_at) = runtime.exit_at {
            value.insert("exitAt".into(), json!(exit_at));
        }
        Value::Object(value)
    }

    pub fn save_snapshot(&self) {
        let tasks = self.tasks();
        let counts = tasks::counts(&tasks);
        let _ = crate::health::write(&self.data_directory, &self.health_value(), &tasks, &counts);
    }
}

fn merge_settings(base: &Settings, stored: &Value) -> Settings {
    // Stored rows are already complete; merge defensively for older databases.
    let mut value = serde_json::to_value(base).unwrap_or_else(|_| json!({}));
    if let (Some(target), Some(source)) = (value.as_object_mut(), stored.as_object()) {
        for (key, item) in source {
            target.insert(key.clone(), item.clone());
        }
    }
    serde_json::from_value(value).unwrap_or_default()
}

fn random_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let mut seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0)
        ^ (std::process::id() as u64) << 32;
    let mut token = String::with_capacity(64);
    for _ in 0..8 {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        token.push_str(&format!("{seed:016x}"));
    }
    token
}

fn task_view(params: &Value, directory: &str) -> Result<TaskView, String> {
    let task = params.get("task").cloned().unwrap_or_else(|| json!({}));
    let options: DownloadOptions = validate_options(params.get("options").unwrap_or(&json!({})))?;
    let group = task.get("group").and_then(|group| {
        group
            .get("title")
            .and_then(Value::as_str)
            .map(|title| Group {
                index: group.get("index").and_then(Value::as_u64).unwrap_or(1) as u32,
                title: title.to_string(),
                id: group
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            })
    });
    Ok(TaskView {
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
            .map(str::to_string)
            .unwrap_or_else(tasks::service_now),
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
        group,
        options,
    })
}

pub fn dispatch(state: &ServiceState, method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "health" => Ok(state.health_value()),
        "configure" => {
            let current = state.settings();
            let next = apply(&current, params)?;
            state.persist_settings(&next)?;
            *state.settings.write().expect("settings lock") = next.clone();
            state.save_snapshot();
            Ok(serde_json::to_value(next).map_err(|error| error.to_string())?)
        }
        "listTasks" => Ok(Value::Array(
            state
                .tasks()
                .iter()
                .take(200)
                .map(tasks::public_task)
                .collect(),
        )),
        "queryTasks" => {
            let tasks = state.tasks();
            let result = tasks::query(&tasks, params)?;
            let mut value = json!({
                "items": result.items,
                "total": result.total,
                "page": result.page,
                "pageSize": result.page_size,
                "counts": result.counts,
            });
            if !state.storage_error.is_empty() {
                value["storageError"] = Value::String(state.storage_error.clone());
            }
            Ok(value)
        }
        "stageTasks" | "createTasks" => {
            let start = method == "createTasks";
            let settings = state.settings();
            let jobs = {
                let store = state.store();
                tasks::enqueue(&store, &settings, params, start)?
            };
            state.save_snapshot();
            Ok(Value::Array(jobs.iter().map(tasks::public_task).collect()))
        }
        "previewPath" => {
            let settings = state.settings();
            let directory = params
                .get("directory")
                .and_then(Value::as_str)
                .unwrap_or(&settings.directory)
                .to_string();
            if !std::path::Path::new(&directory).is_absolute()
                || bewly_core::naming::utf16_len(&directory) > 220
            {
                return Err("保存目录需要使用绝对路径，且长度不能超过 220".into());
            }
            let view = task_view(params, &directory)?;
            let (folder, basename) = output_location(&view, &Streams::default())?;
            Ok(json!({
                "directory": folder.to_string_lossy(),
                "basename": basename,
            }))
        }
        "desktopState" => {
            state.last_tray.store(
                time::OffsetDateTime::now_utc().unix_timestamp() * 1000,
                Ordering::Relaxed,
            );
            let tasks = state.tasks();
            let counts = tasks::counts(&tasks);
            let settings = state.settings();
            Ok(json!({
                "exiting": state.closing.load(Ordering::Relaxed),
                "mode": state.mode,
                "pending": counts.pending,
                "active": counts.active,
                "completed": counts.completed,
                "tray": settings.tray,
                "soundTip": settings.sound_tip,
                "listenClipboard": settings.listen_clipboard,
                "shutdownDue": 0,
            }))
        }
        "expandLink" => {
            let video = params
                .get("video")
                .and_then(Value::as_str)
                .ok_or("缺少视频链接")?;
            crate::net::expand(video).map(Value::String)
        }
        "inspect" => {
            let video = params
                .get("video")
                .and_then(Value::as_str)
                .ok_or("缺少视频链接")?;
            crate::net::inspect(video, "")
        }
        "migrationPreview" => {
            let preview = crate::migration::preview(&state.data_directory, params)?;
            let settings = preview.get("settings").cloned().unwrap_or(Value::Null);
            let current = serde_json::to_value(state.settings()).unwrap_or_else(|_| json!({}));
            let changes: Vec<Value> = settings
                .as_object()
                .map(|object| {
                    object
                        .iter()
                        .map(|(key, value)| {
                            json!({
                                "key": key,
                                "before": current.get(key).cloned().unwrap_or(Value::Null),
                                "after": value,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let id = uuid::Uuid::new_v4().to_string();
            let stored = json!({
                "id": id,
                "settings": settings,
                "records": [],
                "createdAt": now_ms(),
            });
            state
                .store()
                .put_preview(&id, &stored)
                .map_err(|error| error.to_string())?;
            Ok(json!({
                "id": id,
                "profile": preview["profile"],
                "changes": changes,
                "total": 0,
                "duplicate": 0,
                "invalid": 0,
                "missingDirectories": 0,
                "warnings": preview["warnings"],
                "sample": [],
            }))
        }
        "migrationImport" => {
            let id = params
                .get("id")
                .and_then(Value::as_str)
                .ok_or("迁移预览不存在，请重新读取")?;
            let stored = state
                .store()
                .get_preview(id)
                .map_err(|error| error.to_string())?
                .ok_or("迁移预览不存在，请重新读取")?;
            let created = stored.get("createdAt").and_then(Value::as_i64).unwrap_or(0);
            if now_ms() - created > 30 * 60_000 {
                return Err("迁移预览已过期，请重新读取".into());
            }
            let keys: Vec<String> = params
                .get("keys")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let settings = stored
                .get("settings")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            for key in &keys {
                if !settings.contains_key(key) {
                    return Err("无效配置选择".into());
                }
            }
            if !keys.is_empty() {
                let mut patch = serde_json::Map::new();
                for key in &keys {
                    patch.insert(key.clone(), settings[key].clone());
                }
                let next = apply(&state.settings(), &Value::Object(patch))?;
                state.persist_settings(&next)?;
                *state.settings.write().expect("settings lock") = next;
            }
            state
                .store()
                .remove_preview(id)
                .map_err(|error| error.to_string())?;
            state.save_snapshot();
            Ok(json!({
                "imported": 0,
                "duplicate": 0,
                "restoredCovers": 0,
                "settings": keys.len(),
            }))
        }
        "taskAction" => task_action(state, params),
        "batchAction" => batch_action(state, params),
        "tool" => tool_request(state, params),
        "desktopAction" => desktop_action(state, params),
        other => Err(format!("未知下载操作：{other}")),
    }
}

const READ_ONLY_METHODS: [&str; 4] = ["health", "queryTasks", "listTasks", "desktopState"];

fn status_of(task: &Value) -> &str {
    task.get("status").and_then(Value::as_str).unwrap_or("")
}

fn set_status(state: &ServiceState, task: &mut Value, status: &str) -> Result<Value, String> {
    task["status"] = Value::String(status.to_string());
    state
        .store()
        .put_task(task)
        .map_err(|error| error.to_string())?;
    state.save_snapshot();
    Ok(tasks::public_task(task))
}

fn task_action(state: &ServiceState, params: &Value) -> Result<Value, String> {
    let id = params
        .get("id")
        .and_then(Value::as_str)
        .ok_or("任务不存在")?;
    let action = params.get("action").and_then(Value::as_str).unwrap_or("");
    let mut task = state
        .store()
        .task(id)
        .map_err(|error| error.to_string())?
        .ok_or("任务不存在")?;
    let status = status_of(&task).to_string();
    match action {
        "remove" => {
            if tasks::ACTIVE_STATES.contains(&status.as_str()) || status == "queued" {
                return Err("请先暂停任务再移除".into());
            }
            state
                .store()
                .remove_task(id)
                .map_err(|error| error.to_string())?;
            state.save_snapshot();
            Ok(json!({ "id": id, "removed": true }))
        }
        "deleteFiles" => {
            if tasks::ACTIVE_STATES.contains(&status.as_str()) || status == "queued" {
                return Err("请先暂停任务再移除".into());
            }
            let legacy = task.get("legacyPath").and_then(Value::as_str).unwrap_or("");
            let output = task.get("output").and_then(Value::as_str).unwrap_or("");
            if !legacy.is_empty() && output.is_empty() {
                return Err("旧版记录没有可删除的已核验文件，仅可移除记录".into());
            }
            let directory = task.get("directory").and_then(Value::as_str).unwrap_or("");
            let root = std::path::absolute(directory).map_err(|error| error.to_string())?;
            let mut files: Vec<String> = Vec::new();
            if !output.is_empty() {
                files.push(output.to_string());
            }
            if let Some(artifacts) = task.get("artifacts").and_then(Value::as_object) {
                for value in artifacts.values() {
                    if let Some(path) = value.as_str() {
                        if !files.iter().any(|item| item == path) {
                            files.push(path.to_string());
                        }
                    }
                }
            }
            for file in files {
                let absolute = std::path::absolute(&file).map_err(|error| error.to_string())?;
                if absolute.strip_prefix(&root).is_err() {
                    return Err("文件路径超出任务保存目录".into());
                }
                let _ = std::fs::remove_file(&absolute);
            }
            if let Some(object) = task.as_object_mut() {
                object.insert("output".into(), Value::Null);
                object.insert("artifacts".into(), json!({}));
                object.insert("filesDeleted".into(), Value::Bool(true));
            }
            state
                .store()
                .put_task(&task)
                .map_err(|error| error.to_string())?;
            state.save_snapshot();
            Ok(tasks::public_task(&task))
        }
        "start" => {
            if status != "pending" {
                return Err("任务不在待下载列表".into());
            }
            task["error"] = Value::String(String::new());
            set_status(state, &mut task, "queued")
        }
        "pause" | "cancel" => {
            if matches!(status.as_str(), "completed" | "cancelled") {
                return Ok(tasks::public_task(&task));
            }
            if matches!(status.as_str(), "muxing" | "postprocessing") {
                return Err("正在合并或保存附件，请等待当前步骤结束".into());
            }
            task["speed"] = json!(0);
            set_status(
                state,
                &mut task,
                if action == "pause" {
                    "paused"
                } else {
                    "cancelled"
                },
            )
        }
        "resume" | "retry" => {
            if !matches!(status.as_str(), "paused" | "failed" | "cancelled") {
                return Err("任务当前不能恢复".into());
            }
            task["error"] = Value::String(String::new());
            set_status(state, &mut task, "queued")
        }
        _ => Err("无效任务操作".into()),
    }
}

fn batch_action(state: &ServiceState, params: &Value) -> Result<Value, String> {
    let action = params.get("action").and_then(Value::as_str).unwrap_or("");
    if !matches!(
        action,
        "start" | "pause" | "resume" | "retry" | "remove" | "edit"
    ) {
        return Err("无效批量操作".into());
    }
    let ids: Vec<String> = match params.get("ids").and_then(Value::as_array) {
        Some(items) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        None => Vec::new(),
    };
    if params.get("all").is_some() {
        let range = params.get("all").and_then(Value::as_str).unwrap_or("");
        let statuses: &[&str] = match range {
            "pending" => &["pending"],
            "active" => &["queued", "resolving", "downloading", "paused"],
            "failed" => &["failed", "cancelled"],
            "completed" => &["completed"],
            _ => return Err("无效批量范围".into()),
        };
        let ids: Vec<String> = state
            .tasks()
            .iter()
            .filter(|task| statuses.contains(&status_of(task)))
            .filter_map(|task| task.get("id").and_then(Value::as_str).map(str::to_string))
            .collect();
        let mut processed = 0usize;
        let mut errors: Vec<Value> = Vec::new();
        for id in &ids {
            match task_action(state, &json!({ "id": id, "action": action })) {
                Ok(_) => processed += 1,
                Err(error) => errors.push(json!({ "id": id, "error": error })),
            }
        }
        return Ok(json!({
            "processed": processed,
            "errors": errors.iter().take(100).collect::<Vec<_>>(),
            "errorCount": errors.len(),
        }));
    }
    if ids.is_empty() || ids.len() > 200 {
        return Err("无效批量范围".into());
    }
    let mut results = Vec::new();
    let mut errors = Vec::new();
    for id in ids {
        match task_action(state, &json!({ "id": id, "action": action })) {
            Ok(result) => results.push(result),
            Err(error) => errors.push(json!({ "id": id, "error": error })),
        }
    }
    Ok(json!({ "results": results, "errors": errors }))
}

fn tool_request(state: &ServiceState, params: &Value) -> Result<Value, String> {
    let op = params.get("op").and_then(Value::as_str).unwrap_or("");
    match op {
        "convertId" => {
            let input = params.get("input").and_then(Value::as_str).unwrap_or("");
            let store = state.store();
            tools::convert_job(&store, input)
        }
        "status" => {
            let id = params
                .get("id")
                .and_then(Value::as_str)
                .ok_or("工具任务不存在")?;
            let store = state.store();
            tools::load_job(&store, id)?.ok_or_else(|| "工具任务不存在".to_string())
        }
        "pick" => {
            let kind = params
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("directory");
            let dialog = rfd::FileDialog::new();
            let chosen = if kind == "directory" {
                dialog.pick_folder()
            } else {
                dialog.pick_file()
            };
            Ok(match chosen {
                Some(path) => json!({ "path": path.to_string_lossy(), "cancelled": false }),
                None => json!({ "path": Value::Null, "cancelled": true }),
            })
        }
        "cancel" => Ok(json!({ "cancelled": true })),
        _ => Err("此工具操作尚未迁移到 Rust 引擎".into()),
    }
}

fn desktop_action(state: &ServiceState, params: &Value) -> Result<Value, String> {
    match params.get("action").and_then(Value::as_str).unwrap_or("") {
        "keepRunning" => {
            state.lifetime.lock().manual();
            ensure_tray(state);
            Ok(json!({ "mode": "manual" }))
        }
        "cancelShutdown" => Ok(json!({ "cancelled": true })),
        "exit" => {
            state.closing.store(true, Ordering::Relaxed);
            Ok(json!({ "exiting": true }))
        }
        action @ ("start" | "pause") => {
            let range = if action == "start" {
                "pending"
            } else {
                "active"
            };
            batch_action(state, &json!({ "action": action, "all": range }))
        }
        _ => Err("无效托盘操作".into()),
    }
}

/// Starts the platform tray process once. The tray is an RPC client, so keeping
/// the existing C#/Swift implementation needs no protocol work on this side.
pub fn ensure_tray(state: &ServiceState) {
    if !state.caps.tray {
        return;
    }
    let mut guard = state
        .tray
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(child) = guard.as_mut() {
        if child.try_wait().ok().flatten().is_none() {
            return;
        }
    }
    let Ok(executable) = std::env::current_exe() else {
        return;
    };
    let Some(directory) = executable.parent() else {
        return;
    };
    let name = if cfg!(target_os = "windows") {
        "BewlyDownloadTray.exe"
    } else {
        "BewlyTray"
    };
    let tray = directory.join(name);
    if !tray.exists() {
        return;
    }
    let spawned = std::process::Command::new(tray)
        .arg("--tray")
        .arg(&state.data_directory)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok();
    *guard = spawned;
}

fn forbidden() -> Response {
    (
        StatusCode::FORBIDDEN,
        axum::Json(json!({ "ok": false, "error": "Forbidden" })),
    )
        .into_response()
}

async fn rpc(
    AxumState(state): AxumState<Arc<ServiceState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if headers.contains_key("origin") {
        return forbidden();
    }
    let authorization = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let expected = format!("Bearer {}", state.token);
    if authorization.len() != expected.len()
        || authorization
            .as_bytes()
            .ct_eq(expected.as_bytes())
            .unwrap_u8()
            == 0
    {
        return forbidden();
    }
    if body.len() > 2 * 1024 * 1024 {
        return axum::Json(json!({ "ok": false, "error": "请求过大" })).into_response();
    }
    let payload: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => {
            return axum::Json(json!({ "ok": false, "error": "请求格式无效" })).into_response()
        }
    };
    let method = payload.get("method").and_then(Value::as_str).unwrap_or("");
    let params = payload.get("params").cloned().unwrap_or_else(|| json!({}));
    if state.closing.load(Ordering::Relaxed) && method != "desktopState" {
        return axum::Json(json!({
            "ok": false,
            "code": "SERVICE_STOPPING",
            "error": "下载助手正在空闲退出",
        }))
        .into_response();
    }
    let read_only = READ_ONLY_METHODS.contains(&method)
        || (method == "tool" && params.get("op").and_then(Value::as_str) == Some("status"));
    if !read_only {
        state.lifetime.lock().touch();
    }
    state.active_requests.fetch_add(1, Ordering::Relaxed);
    let result = dispatch(&state, method, &params);
    state.active_requests.fetch_sub(1, Ordering::Relaxed);
    let runtime = state.runtime();
    match result {
        Ok(result) => {
            axum::Json(json!({ "ok": true, "result": result, "runtime": runtime })).into_response()
        }
        Err(error) => axum::Json(json!({ "ok": false, "error": error })).into_response(),
    }
}

async fn fallback() -> Response {
    (StatusCode::NOT_FOUND, "{}").into_response()
}

pub async fn run(data_directory: PathBuf, mode: String) -> Result<(), String> {
    let state = Arc::new(ServiceState::open(&data_directory, &mode)?);
    let token = state.token.clone();
    state.save_snapshot();
    ensure_tray(&state);
    crate::worker::spawn(state.clone());
    let housekeeping = state.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            ticker.tick().await;
            let runtime = housekeeping.runtime();
            if let Some(exit_at) = runtime.get("exitAt").and_then(Value::as_i64) {
                if now_ms() >= exit_at {
                    housekeeping.closing.store(true, Ordering::Relaxed);
                    housekeeping.save_snapshot();
                    let _ =
                        std::fs::remove_file(housekeeping.data_directory.join("connection.json"));
                    // Give the in-flight reply a moment to leave the socket.
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    std::process::exit(0);
                }
            }
        }
    });
    let app = Router::new()
        .route("/rpc", post(rpc))
        .fallback(fallback)
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let descriptor = state.data_directory.join("connection.json");
    let payload = json!({
        "port": port,
        "token": token,
        "pid": std::process::id(),
    });
    std::fs::write(&descriptor, payload.to_string()).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&descriptor, std::fs::Permissions::from_mode(0o600));
    }
    axum::serve(listener, app)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> (tempdir::Temp, ServiceState) {
        let directory = std::env::temp_dir().join(format!(
            "bewly-service-{}-{}",
            std::process::id(),
            time::OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        let state = ServiceState::open(&directory, "manual").unwrap();
        (tempdir::Temp(directory), state)
    }

    mod tempdir {
        use std::path::PathBuf;
        pub struct Temp(pub PathBuf);
        impl Drop for Temp {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn health_reports_protocol_and_settings() {
        let (_temp, state) = state();
        let value = dispatch(&state, "health", &json!({})).unwrap();
        assert_eq!(value["protocol"], 2);
        assert_eq!(value["settings"]["maxConcurrent"], 2);
        assert!(value["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item == "audio-highest"));
    }

    #[test]
    fn configure_persists_and_returns_the_merged_settings() {
        let (_temp, state) = state();
        let value = dispatch(&state, "configure", &json!({ "maxConcurrent": 3 })).unwrap();
        assert_eq!(value["maxConcurrent"], 3);
        assert_eq!(
            state.store().settings().unwrap().unwrap()["maxConcurrent"],
            3
        );
    }

    #[test]
    fn unknown_methods_keep_the_contract_message() {
        let (_temp, state) = state();
        assert_eq!(
            dispatch(&state, "nope", &json!({})).unwrap_err(),
            "未知下载操作：nope"
        );
    }
}
