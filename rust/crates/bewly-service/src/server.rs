//! Local RPC server: `POST /rpc` on loopback with bearer auth and no CORS.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
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
use crate::settings::{apply, Settings};
use crate::tasks;

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
        "taskAction" => {
            let id = params
                .get("id")
                .and_then(Value::as_str)
                .ok_or("任务不存在")?;
            let action = params.get("action").and_then(Value::as_str).unwrap_or("");
            let task = state.store().task(id).map_err(|error| error.to_string())?;
            let Some(mut task) = task else {
                return Err("任务不存在".into());
            };
            match action {
                "remove" => {
                    let status = task.get("status").and_then(Value::as_str).unwrap_or("");
                    if tasks::ACTIVE_STATES.contains(&status) {
                        return Err("请先暂停任务再移除".into());
                    }
                    state
                        .store()
                        .remove_task(id)
                        .map_err(|error| error.to_string())?;
                    state.save_snapshot();
                    Ok(json!({ "id": id, "removed": true }))
                }
                "start" => {
                    if task.get("status").and_then(Value::as_str) != Some("pending") {
                        return Err("任务不在待下载列表".into());
                    }
                    task["status"] = Value::String("queued".into());
                    task["error"] = Value::String(String::new());
                    state
                        .store()
                        .put_task(&task)
                        .map_err(|error| error.to_string())?;
                    state.save_snapshot();
                    Ok(tasks::public_task(&task))
                }
                _ => Err("下载功能尚未迁移到 Rust 引擎".into()),
            }
        }
        "batchAction" => {
            let action = params.get("action").and_then(Value::as_str).unwrap_or("");
            if action != "remove" && action != "edit" {
                return Err("下载功能尚未迁移到 Rust 引擎".into());
            }
            let ids: Vec<String> = match params.get("ids").and_then(Value::as_array) {
                Some(items) => items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect(),
                None => Vec::new(),
            };
            if ids.is_empty() {
                return Err("无效批量范围".into());
            }
            let mut results = Vec::new();
            let mut errors = Vec::new();
            for id in ids.iter().take(200) {
                let Some(mut task) = state.store().task(id).map_err(|error| error.to_string())?
                else {
                    errors.push(json!({ "id": id, "error": "任务不存在" }));
                    continue;
                };
                match action {
                    "remove" => {
                        let status = task.get("status").and_then(Value::as_str).unwrap_or("");
                        if tasks::ACTIVE_STATES.contains(&status) {
                            errors.push(json!({ "id": id, "error": "请先暂停任务再移除" }));
                            continue;
                        }
                        state
                            .store()
                            .remove_task(id)
                            .map_err(|error| error.to_string())?;
                        results.push(json!({ "id": id, "removed": true }));
                    }
                    _ => {
                        let status = task.get("status").and_then(Value::as_str).unwrap_or("");
                        if !matches!(status, "pending" | "failed") {
                            errors.push(json!({ "id": id, "error": "只能修改待下载或失败任务" }));
                            continue;
                        }
                        let options =
                            validate_options(params.get("options").unwrap_or(&json!({})))?;
                        task["options"] =
                            serde_json::to_value(&options).map_err(|error| error.to_string())?;
                        state
                            .store()
                            .put_task(&task)
                            .map_err(|error| error.to_string())?;
                        results.push(json!({ "id": id, "options": options }));
                    }
                }
            }
            state.save_snapshot();
            Ok(json!({ "results": results, "errors": errors }))
        }
        other => Err(format!("未知下载操作：{other}")),
    }
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
    let runtime = json!({
        "running": true,
        "mode": state.mode,
        "state": if state.closing.load(Ordering::Relaxed) { "stopping" } else { "idle" },
    });
    match dispatch(&state, method, &params) {
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
