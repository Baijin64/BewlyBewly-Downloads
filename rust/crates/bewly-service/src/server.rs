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

const SESSION_KEY: &[u8] = b"bewly-download-session-v2";

fn obfuscate_session(cookie: &str) -> Vec<u8> {
    cookie
        .as_bytes()
        .iter()
        .enumerate()
        .map(|(i, &b)| b ^ SESSION_KEY[i % SESSION_KEY.len()])
        .collect()
}

fn deobfuscate_session(bytes: &[u8]) -> Option<String> {
    let deobfuscated: Vec<u8> = bytes
        .iter()
        .enumerate()
        .map(|(i, &b)| b ^ SESSION_KEY[i % SESSION_KEY.len()])
        .collect();
    String::from_utf8(deobfuscated).ok()
}

fn save_session(data_directory: &Path, cookie: &str) {
    let path = data_directory.join("session.dat");
    if cookie.is_empty() {
        let _ = std::fs::remove_file(path);
    } else {
        let data = obfuscate_session(cookie);
        if std::fs::write(&path, &data).is_ok() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
        }
    }
}

fn load_session(data_directory: &Path) -> String {
    let path = data_directory.join("session.dat");
    if let Ok(data) = std::fs::read(&path) {
        if let Some(cookie) = deobfuscate_session(&data) {
            if cookie.len() <= 32768 && !cookie.contains(['\r', '\n']) {
                return cookie;
            }
        }
    }
    String::new()
}

#[cfg(windows)]
fn is_pid_alive(pid: u32) -> bool {
    extern "system" {
        fn OpenProcess(
            dwDesiredAccess: u32,
            bInheritHandle: i32,
            dwProcessId: u32,
        ) -> *mut std::ffi::c_void;
        fn CloseHandle(hObject: *mut std::ffi::c_void) -> i32;
        fn GetExitCodeProcess(hProcess: *mut std::ffi::c_void, lpExitCode: *mut u32) -> i32;
    }
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut exit_code: u32 = 0;
        let success = GetExitCodeProcess(handle, &mut exit_code);
        CloseHandle(handle);
        success != 0 && exit_code == STILL_ACTIVE
    }
}

#[cfg(unix)]
fn is_pid_alive(pid: u32) -> bool {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    unsafe { kill(pid as i32, 0) == 0 }
}

#[cfg(not(any(windows, unix)))]
fn is_pid_alive(_pid: u32) -> bool {
    false
}

fn acquire_service_lock(data_directory: &Path) -> Result<(), String> {
    std::fs::create_dir_all(data_directory).map_err(|error| error.to_string())?;
    let lock_path = data_directory.join("service.lock");
    if lock_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&lock_path) {
            if let Ok(pid) = content.trim().parse::<u32>() {
                if is_pid_alive(pid) && pid != std::process::id() {
                    return Err(format!("另一个下载服务实例正在运行 (PID: {pid})"));
                }
            }
        }
    }
    std::fs::write(&lock_path, std::process::id().to_string())
        .map_err(|error| format!("无法写入服务锁文件: {error}"))?;
    Ok(())
}

fn open_system_target(action: &str, target: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let target_str = target.to_string_lossy();
        let mut cmd = std::process::Command::new("explorer.exe");
        if action == "reveal" {
            // Explorer parses its own command line: the quotes must reach it as
            // written, not escaped the way `arg` does for paths with spaces.
            cmd.raw_arg(format!("/select,\"{target_str}\""));
        } else {
            // Explorer opens a file with its default app without going through
            // cmd.exe, which would flash a console and treat `&` in a title as a
            // command separator.
            cmd.arg(target);
        }
        cmd.spawn()
            .map_err(|error| format!("无法打开目标: {error}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if action == "reveal" {
            cmd.arg("-R");
        }
        cmd.arg(target);
        cmd.spawn()
            .map_err(|error| format!("无法打开目标: {error}"))?;
    }
    #[cfg(target_os = "android")]
    {
        let _ = (action, target);
        return Err("Android 端请在应用内打开文件".into());
    }
    #[cfg(all(
        not(target_os = "windows"),
        not(target_os = "macos"),
        not(target_os = "android")
    ))]
    {
        let target_to_open = if action == "reveal" {
            target.parent().unwrap_or(target)
        } else {
            target
        };
        let mut cmd = std::process::Command::new("xdg-open");
        cmd.arg(target_to_open);
        cmd.spawn()
            .map_err(|error| format!("无法打开目标: {error}"))?;
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(())
    }
}

fn trigger_system_shutdown() {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("shutdown.exe")
            .args(["/s", "/t", "0"])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("osascript")
            .args(["-e", "tell application \"System Events\" to shut down"])
            .spawn();
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("systemctl")
            .arg("poweroff")
            .spawn();
    }
}

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
    pub cookie: std::sync::Mutex<String>,
    pub policy: std::sync::Mutex<crate::lifetime::CompletionPolicy>,
    pub last_snapshot_at: std::sync::Mutex<Option<std::time::Instant>>,
}

impl ServiceState {
    pub fn open(data_directory: &Path, mode: &str) -> Result<Self, String> {
        std::fs::create_dir_all(data_directory).map_err(|error| error.to_string())?;
        let store = Store::open(data_directory).map_err(|error| error.to_string())?;
        let settings = match store.settings().map_err(|error| error.to_string())? {
            Some(value) => merge_settings(&Settings::default(), &value),
            None => Settings::default(),
        };
        let initial_cookie = load_session(data_directory);
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
            cookie: std::sync::Mutex::new(initial_cookie),
            policy: std::sync::Mutex::new(crate::lifetime::CompletionPolicy::new()),
            last_snapshot_at: std::sync::Mutex::new(Some(std::time::Instant::now())),
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
        let active = self.store().has_active_tasks().unwrap_or(false);
        let busy = self
            .running
            .lock()
            .map(|map| !map.is_empty())
            .unwrap_or(false)
            || self.active_requests.load(Ordering::Relaxed) > 0
            || active
            || self.policy.lock().map(|p| p.due > 0).unwrap_or(false);
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
        if let Ok(mut guard) = self.last_snapshot_at.lock() {
            *guard = Some(std::time::Instant::now());
        }
        let tasks = self.tasks();
        let counts = tasks::counts(&tasks);
        let _ = crate::health::write(&self.data_directory, &self.health_value(), &tasks, &counts);
    }

    pub fn save_snapshot_throttled(&self, min_interval: std::time::Duration) -> Result<(), String> {
        let should_save = if let Ok(mut guard) = self.last_snapshot_at.lock() {
            match *guard {
                Some(last) if last.elapsed() < min_interval => false,
                _ => {
                    *guard = Some(std::time::Instant::now());
                    true
                }
            }
        } else {
            true
        };
        if should_save {
            let tasks = self.tasks();
            let counts = tasks::counts(&tasks);
            crate::health::write(&self.data_directory, &self.health_value(), &tasks, &counts)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
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
        "ping" => Ok(json!({ "pong": true })),
        "health" => Ok(state.health_value()),
        "configure" | "saveSettings" => {
            let current = state.settings();
            let next = apply(&current, params)?;
            state.persist_settings(&next)?;
            *state.settings.write().expect("settings lock") = next.clone();
            state.save_snapshot();
            Ok(serde_json::to_value(next).map_err(|error| error.to_string())?)
        }
        "setSession" => {
            if let Some(s) = params.get("session").and_then(Value::as_str) {
                *state
                    .cookie
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = s.to_string();
                save_session(&state.data_directory, s);
            }
            Ok(json!({ "saved": true }))
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
            let mut effective_params = params.clone();
            if effective_params.get("info").is_none() {
                if let Some(video) = effective_params.get("video").and_then(Value::as_str) {
                    let cookie = state
                        .cookie
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .clone();
                    let info = crate::net::inspect(video, &cookie)?;
                    if let Some(obj) = effective_params.as_object_mut() {
                        obj.insert("info".into(), info);
                    }
                }
            }
            let jobs = {
                let store = state.store();
                tasks::enqueue(&store, &settings, &effective_params, start)?
            };
            if start {
                let all_tasks = state.tasks();
                let mut policy = state
                    .policy
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                policy.begin(&all_tasks);
                for job in &jobs {
                    if let Some(id) = job.get("id").and_then(Value::as_str) {
                        policy.started(id);
                    }
                }
            }
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
        "taskFile" => {
            let action = params.get("action").and_then(Value::as_str).unwrap_or("");
            if !matches!(action, "play" | "reveal" | "folder") {
                return Err("无效文件操作".into());
            }
            let id = params.get("id").and_then(Value::as_str).unwrap_or("");
            let task = if !id.is_empty() {
                state.store().task(id).map_err(|error| error.to_string())?
            } else {
                None
            };
            if task.is_none() && action != "folder" {
                return Err("任务不存在".into());
            }
            let file: Option<String> = task.as_ref().and_then(|t| {
                if let Some(output) = t.get("output").and_then(Value::as_str) {
                    if !output.is_empty() {
                        return Some(output.to_string());
                    }
                }
                if let Some(artifacts) = t.get("artifacts").and_then(Value::as_object) {
                    for val in artifacts.values() {
                        if let Some(path_str) = val.as_str() {
                            if !path_str.is_empty() {
                                return Some(path_str.to_string());
                            }
                        }
                    }
                }
                None
            });
            let legacy_path = task
                .as_ref()
                .and_then(|t| t.get("legacyPath").and_then(Value::as_str))
                .filter(|s| !s.is_empty());
            if task.is_some() && file.is_none() && !(action == "folder" && legacy_path.is_some()) {
                return Err("任务没有输出文件".into());
            }
            let target: PathBuf = if action == "folder" {
                if let Some(lp) = legacy_path {
                    PathBuf::from(lp)
                } else if let Some(ref f) = file {
                    Path::new(f)
                        .parent()
                        .map(Path::to_path_buf)
                        .unwrap_or_else(|| PathBuf::from(state.settings().directory))
                } else {
                    PathBuf::from(state.settings().directory)
                }
            } else {
                PathBuf::from(file.as_ref().unwrap())
            };

            if action == "folder" {
                if !target.is_dir() {
                    return Err("目录不存在".into());
                }
            } else {
                if !target.is_file() {
                    return Err("文件不存在".into());
                }
                if action == "play" {
                    let ext = target
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| format!(".{}", e.to_ascii_lowercase()))
                        .unwrap_or_default();
                    const PLAYABLE_EXTS: &[&str] = &[
                        ".mp4", ".mkv", ".m4a", ".mp3", ".flac", ".mka", ".aac", ".wav", ".eac3",
                    ];
                    if !PLAYABLE_EXTS.contains(&ext.as_str()) {
                        return Err("此文件不能作为媒体播放".into());
                    }
                }
            }

            if std::env::var("BEWLY_DOWNLOAD_HEADLESS").ok().as_deref() != Some("1") {
                open_system_target(action, &target)?;
            }
            Ok(json!({ "opened": true }))
        }
        "clipboardVideo" => {
            let settings = state.settings();
            if !settings.listen_clipboard {
                return Err("剪贴板监听未启用".into());
            }
            let video = params
                .get("video")
                .and_then(Value::as_str)
                .ok_or("缺少视频链接")?;
            let cookie = state
                .cookie
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            let info = crate::net::inspect(video, &cookie)?;
            let first_cid = info
                .get("pages")
                .and_then(Value::as_array)
                .and_then(|pages| pages.first())
                .and_then(|p| p.get("cid"))
                .cloned()
                .ok_or("视频没有有效分 P")?;
            let default_opts =
                serde_json::to_value(&settings.default_options).unwrap_or_else(|_| json!({}));
            let enqueue_params = json!({
                "info": info,
                "cids": [first_cid],
                "options": default_opts,
            });
            let store = state.store();
            let jobs = tasks::enqueue(&store, &settings, &enqueue_params, false)?;
            drop(store);
            state.save_snapshot();
            Ok(Value::Array(jobs.iter().map(tasks::public_task).collect()))
        }
        "desktopState" => {
            state.last_tray.store(
                time::OffsetDateTime::now_utc().unix_timestamp() * 1000,
                Ordering::Relaxed,
            );
            let tasks = state.tasks();
            let counts = tasks::counts(&tasks);
            let settings = state.settings();
            let (completed, shutdown_due) = {
                let policy = state
                    .policy
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                (policy.completed, policy.due)
            };
            Ok(json!({
                "exiting": state.closing.load(Ordering::Relaxed),
                "mode": state.mode,
                "pending": counts.pending,
                "active": counts.active,
                "completed": completed,
                "tray": settings.tray,
                "soundTip": settings.sound_tip,
                "listenClipboard": settings.listen_clipboard,
                "shutdownDue": shutdown_due,
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
            let cookie = state
                .cookie
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            crate::net::inspect(video, &cookie)
        }
        "migrationPreview" => {
            let store = state.store();
            let preview = crate::migration::preview(&store, &state.data_directory, params)?;
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
                "records": preview["records"],
                "createdAt": now_ms(),
            });
            store
                .put_preview(&id, &stored)
                .map_err(|error| error.to_string())?;
            Ok(json!({
                "id": id,
                "profile": preview["profile"],
                "changes": changes,
                "total": preview["total"],
                "duplicate": preview["duplicate"],
                "invalid": preview["invalid"],
                "missingDirectories": preview["missingDirectories"],
                "warnings": preview["warnings"],
                "sample": preview["sample"],
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
            let mut imported = 0;
            let mut duplicate = 0;
            let mut restored_covers = 0;

            if params.get("history").and_then(Value::as_bool) == Some(true) {
                if let Some(records) = stored.get("records").and_then(Value::as_array) {
                    let store = state.store();
                    let all_tasks = store.tasks().map_err(|e| e.to_string())?;
                    for record in records {
                        let record_id = record.get("id").and_then(Value::as_str).unwrap_or("");
                        let legacy_id = record
                            .get("legacySourceId")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        let existing = all_tasks.iter().find(|t| {
                            let t_id = t.get("id").and_then(Value::as_str).unwrap_or("");
                            let t_legacy = t
                                .get("legacySourceId")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            t_id == record_id
                                || (!legacy_id.is_empty()
                                    && (t_id == legacy_id || t_legacy == legacy_id))
                        });
                        if let Some(existing) = existing {
                            duplicate += 1;
                            let existing_cover =
                                existing.get("cover").and_then(Value::as_str).unwrap_or("");
                            let new_cover =
                                record.get("cover").and_then(Value::as_str).unwrap_or("");
                            if existing_cover.is_empty() && !new_cover.is_empty() {
                                let mut updated = existing.clone();
                                updated["cover"] = Value::String(new_cover.to_string());
                                let _ = store.put_task(&updated);
                                restored_covers += 1;
                            }
                        } else {
                            let _ = store.put_task(record);
                            imported += 1;
                        }
                    }
                }
            }

            state
                .store()
                .remove_preview(id)
                .map_err(|error| error.to_string())?;
            state.save_snapshot();
            Ok(json!({
                "imported": imported,
                "duplicate": duplicate,
                "restoredCovers": restored_covers,
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
const ACTIVE_STATES: [&str; 4] = ["resolving", "downloading", "muxing", "postprocessing"];

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
            for _ in 0..50 {
                let is_running = state
                    .running
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .contains_key(id);
                if !is_running {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            let task = state
                .store()
                .task(id)
                .map_err(|error| error.to_string())?
                .ok_or("任务不存在")?;
            let status = status_of(&task).to_string();
            if ACTIVE_STATES.contains(&status.as_str()) || status == "queued" {
                return Err("请先暂停任务再移除".into());
            }
            state
                .store()
                .remove_task(id)
                .map_err(|error| error.to_string())?;
            let _ = std::fs::remove_dir_all(state.data_directory.join("partial").join(id));
            state.save_snapshot();
            Ok(json!({ "id": id, "removed": true }))
        }
        "deleteFiles" => {
            if ACTIVE_STATES.contains(&status.as_str()) || status == "queued" {
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
            let result = set_status(state, &mut task, "queued")?;
            {
                let mut policy = state
                    .policy
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                policy.begin(&state.tasks());
                policy.started(id);
            }
            Ok(result)
        }
        "pause" | "cancel" => {
            let public = {
                // The run's stop flag and the new status change together under
                // the store lock. The worker checks the flag under the same lock
                // before every write, so a run that is still draining can never
                // write its stale copy over the pause (or over a later resume).
                let store = state.store();
                let mut task = store
                    .task(id)
                    .map_err(|error| error.to_string())?
                    .ok_or("任务不存在")?;
                let status = status_of(&task).to_string();
                if matches!(status.as_str(), "completed" | "cancelled") {
                    return Ok(tasks::public_task(&task));
                }
                if matches!(status.as_str(), "muxing" | "postprocessing") {
                    return Err("正在合并或保存附件，请等待当前步骤结束".into());
                }
                if let Some(flag) = state
                    .running
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .get(id)
                {
                    flag.store(true, Ordering::Relaxed);
                }
                task["speed"] = json!(0);
                task["status"] = Value::String(
                    if action == "pause" {
                        "paused"
                    } else {
                        "cancelled"
                    }
                    .to_string(),
                );
                store.put_task(&task).map_err(|error| error.to_string())?;
                tasks::public_task(&task)
            };
            state.save_snapshot();
            Ok(public)
        }
        "resume" | "retry" => {
            if !matches!(status.as_str(), "paused" | "failed" | "cancelled") {
                return Err("任务当前不能恢复".into());
            }
            if let Some(prepared) = params.get("prepared") {
                if !prepared.is_null() {
                    let validated = tasks::validate_prepared(prepared)?;
                    task["prepared"] = validated;
                }
            }
            task["error"] = Value::String(String::new());
            let result = set_status(state, &mut task, "queued")?;
            {
                let mut policy = state
                    .policy
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                policy.begin(&state.tasks());
                policy.started(id);
            }
            Ok(result)
        }
        "edit" => {
            let default_opts = json!({});
            let options_val = params.get("options").unwrap_or(&default_opts);
            let public = tasks::edit_task(&mut task, options_val)?;
            state
                .store()
                .put_task(&task)
                .map_err(|error| error.to_string())?;
            state.save_snapshot();
            Ok(public)
        }
        _ => Err("无效任务操作".into()),
    }
}

fn batch_action(state: &ServiceState, params: &Value) -> Result<Value, String> {
    let raw_action = params.get("action").and_then(Value::as_str).unwrap_or("");
    let (action, all_override) = if raw_action == "clearCompleted" {
        ("remove", Some("completed"))
    } else {
        (raw_action, None)
    };
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
    let all_spec = all_override.or_else(|| params.get("all").and_then(Value::as_str));
    if let Some(range) = all_spec {
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
            let mut sub_params = json!({ "id": id, "action": action });
            if action == "edit" {
                if let Some(options) = params.get("options") {
                    sub_params["options"] = options.clone();
                }
            }
            match task_action(state, &sub_params) {
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
        let mut sub_params = json!({ "id": id, "action": action });
        if action == "edit" {
            if let Some(options) = params.get("options") {
                sub_params["options"] = options.clone();
            }
        }
        match task_action(state, &sub_params) {
            Ok(result) => results.push(result),
            Err(error) => errors.push(json!({ "id": id, "error": error })),
        }
    }
    Ok(json!({ "results": results, "errors": errors }))
}

fn tool_request(state: &ServiceState, params: &Value) -> Result<Value, String> {
    // The picker waits on the user; holding the store meanwhile would stall
    // every download's progress write and every task query.
    if params.get("op").and_then(Value::as_str) == Some("pick") {
        let job = tools::pick_job(params)?;
        tools::store_job(&state.store(), &job)?;
        return Ok(job);
    }
    let default_directory = state.settings().directory;
    let cookie = state
        .cookie
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let store = state.store();
    tools::execute_tool(&store, &default_directory, &cookie, params)
}

fn desktop_action(state: &ServiceState, params: &Value) -> Result<Value, String> {
    match params.get("action").and_then(Value::as_str).unwrap_or("") {
        "keepRunning" => {
            state.lifetime.lock().manual();
            ensure_tray(state);
            Ok(json!({ "mode": "manual" }))
        }
        "cancelShutdown" => {
            state
                .policy
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .cancel();
            Ok(json!({ "cancelled": true }))
        }
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
    if let Some(session) = payload.get("session") {
        let valid_cookie = if session.is_null() {
            Some("")
        } else {
            session
                .as_str()
                .filter(|text| text.len() <= 32768 && !text.contains(['\r', '\n']))
        };

        if let Some(cookie) = valid_cookie {
            *state
                .cookie
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = cookie.to_string();
            save_session(&state.data_directory, cookie);
        } else {
            return axum::Json(json!({ "ok": false, "error": "无效登录信息" })).into_response();
        }
    }
    let read_only = READ_ONLY_METHODS.contains(&method)
        || (method == "tool" && params.get("op").and_then(Value::as_str) == Some("status"));
    if !read_only {
        state.lifetime.lock().touch();
    }
    state.active_requests.fetch_add(1, Ordering::Relaxed);
    // Dispatch can block on the network or a native dialog; keep it off the
    // async workers so the scheduler and other requests keep running.
    let dispatch_state = Arc::clone(&state);
    let dispatch_method = method.to_string();
    let result =
        tokio::task::spawn_blocking(move || dispatch(&dispatch_state, &dispatch_method, &params))
            .await
            .unwrap_or_else(|_| Err("下载助手内部错误".into()));
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
    let (_tx, rx) = tokio::sync::watch::channel(false);
    run_with_shutdown(data_directory, mode, rx).await
}

pub async fn run_with_shutdown(
    data_directory: PathBuf,
    mode: String,
    mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
) -> Result<(), String> {
    acquire_service_lock(&data_directory)?;
    let state = Arc::new(ServiceState::open(&data_directory, &mode)?);
    let token = state.token.clone();
    state.save_snapshot();
    ensure_tray(&state);
    crate::worker::spawn(state.clone());
    #[allow(unused_variables)]
    let (internal_tx, mut internal_rx) = tokio::sync::watch::channel(false);
    let housekeeping = state.clone();
    let housekeeping_handle = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            ticker.tick().await;
            let now = now_ms();
            let tasks = housekeeping.tasks();
            let shutdown_enabled = housekeeping.settings().shutdown;
            let due = housekeeping
                .policy
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .evaluate(&tasks, shutdown_enabled, now);

            if due > 0
                && now >= due
                && std::env::var("BEWLY_DOWNLOAD_HEADLESS").ok().as_deref() != Some("1")
            {
                housekeeping
                    .policy
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .cancel();
                trigger_system_shutdown();
            }

            let runtime = housekeeping.runtime();
            if let Some(exit_at) = runtime.get("exitAt").and_then(Value::as_i64) {
                if now_ms() >= exit_at {
                    housekeeping.closing.store(true, Ordering::Relaxed);
                    housekeeping.save_snapshot();
                    let _ =
                        std::fs::remove_file(housekeeping.data_directory.join("connection.json"));
                    let _ = std::fs::remove_file(housekeeping.data_directory.join("service.lock"));
                    // Give the in-flight reply a moment to leave the socket.
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    #[cfg(not(target_os = "android"))]
                    std::process::exit(0);
                    #[cfg(target_os = "android")]
                    {
                        let _ = internal_tx.send(true);
                        break;
                    }
                }
            }
        }
    });

    struct CleanupGuard {
        data_directory: PathBuf,
    }
    impl Drop for CleanupGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(self.data_directory.join("connection.json"));
            let _ = std::fs::remove_file(self.data_directory.join("service.lock"));
        }
    }
    let _guard = CleanupGuard {
        data_directory: state.data_directory.clone(),
    };

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
    let closing_state = state.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            tokio::select! {
                _ = shutdown_rx.wait_for(|v| *v) => {},
                _ = internal_rx.changed() => {},
            }
            closing_state.closing.store(true, Ordering::Relaxed);
            closing_state.save_snapshot();
        })
        .await
        .map_err(|error| error.to_string())?;
    housekeeping_handle.abort();
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

    #[test]
    fn session_persistence_roundtrip() {
        let (temp, _state) = state();
        let cookie_val = "SESSDATA=test_cookie_12345; DedeUserID=98765";
        save_session(&temp.0, cookie_val);
        let loaded = load_session(&temp.0);
        assert_eq!(loaded, cookie_val);

        save_session(&temp.0, "");
        assert_eq!(load_session(&temp.0), "");
        assert!(!temp.0.join("session.dat").exists());
    }

    #[test]
    fn desktop_state_and_action_cancel_shutdown() {
        let (_temp, state) = state();
        {
            let mut policy = state.policy.lock().unwrap();
            policy.due = 123456;
            policy.completed = 5;
        }
        let ds = dispatch(&state, "desktopState", &json!({})).unwrap();
        assert_eq!(ds["completed"], 5);
        assert_eq!(ds["shutdownDue"], 123456);

        let res = dispatch(
            &state,
            "desktopAction",
            &json!({ "action": "cancelShutdown" }),
        )
        .unwrap();
        assert_eq!(res["cancelled"], true);
        assert_eq!(state.policy.lock().unwrap().due, 0);
    }

    #[test]
    fn service_lock_guard() {
        let temp_dir = std::env::temp_dir().join(format!("bewly-lock-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&temp_dir);
        assert!(acquire_service_lock(&temp_dir).is_ok());
        assert!(temp_dir.join("service.lock").exists());
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn task_action_edit_validation() {
        let (_temp, state) = state();
        // Missing task returns error
        assert_eq!(
            dispatch(
                &state,
                "taskAction",
                &json!({ "id": "none", "action": "edit" })
            )
            .unwrap_err(),
            "任务不存在"
        );
    }
}
