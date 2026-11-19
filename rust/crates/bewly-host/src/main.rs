//! Single binary with several entry points:
//!   `--service`  run the loopback RPC service
//!   `--start-service` spawn a detached service and print `{ "pid": n }`
//!   `--version`  print the helper version
//!   `--register` write native messaging host manifests and register with browsers
//!   `--unregister` remove native messaging host manifests and browser registrations
//!   `chrome-extension://…` native messaging host on stdio
//!   anything else prints usage

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;

use bewly_proto::frame::{read_frame, write_frame};
use serde_json::{json, Value};

const VERSION: &str = "0.3.0";

static LAST_SERVICE_PID: AtomicU32 = AtomicU32::new(0);
static DISPATCHING: AtomicUsize = AtomicUsize::new(0);

fn data_directory() -> PathBuf {
    if let Ok(explicit) = std::env::var("BEWLY_DOWNLOAD_DATA") {
        return PathBuf::from(explicit);
    }
    if cfg!(target_os = "windows") {
        return PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default())
            .join("BewlyDownload");
    }
    if cfg!(target_os = "macos") {
        return PathBuf::from(std::env::var("HOME").unwrap_or_default())
            .join("Library")
            .join("Application Support")
            .join("BewlyDownload");
    }
    PathBuf::from(
        std::env::var("XDG_DATA_HOME").unwrap_or_else(|_| {
            format!("{}/.local/share", std::env::var("HOME").unwrap_or_default())
        }),
    )
    .join("bewly-download")
}

fn mode() -> String {
    std::env::var("BEWLY_DOWNLOAD_MODE").unwrap_or_else(|_| "manual".to_string())
}

fn allowed_origins() -> Vec<String> {
    if let Ok(path) = std::env::var("BEWLY_IDENTITY_FILE") {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                let mut origins = Vec::new();
                if let Some(id) = value.get("extensionId").and_then(Value::as_str) {
                    origins.push(format!("chrome-extension://{id}/"));
                }
                if let Some(legacy) = value.get("legacyExtensionIds").and_then(Value::as_array) {
                    for id in legacy {
                        if let Some(id) = id.as_str() {
                            origins.push(format!("chrome-extension://{id}/"));
                        }
                    }
                }
                if !origins.is_empty() {
                    return origins;
                }
            }
        }
    }
    let directory = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()))
        .unwrap_or_default();
    for candidate in [
        directory.join("identity.json"),
        directory.join("../Resources/identity.json"),
        directory.join("../../platforms/identity.json"),
        directory.join("../../../platforms/identity.json"),
    ] {
        if let Ok(text) = std::fs::read_to_string(candidate) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                let mut origins = Vec::new();
                if let Some(id) = value.get("extensionId").and_then(Value::as_str) {
                    origins.push(format!("chrome-extension://{id}/"));
                }
                if let Some(legacy) = value.get("legacyExtensionIds").and_then(Value::as_array) {
                    for id in legacy {
                        if let Some(id) = id.as_str() {
                            origins.push(format!("chrome-extension://{id}/"));
                        }
                    }
                }
                if !origins.is_empty() {
                    return origins;
                }
            }
        }
    }
    vec![
        "chrome-extension://knnflmlfhhiajbjolfbgkjiadnpmmlcn/".into(),
        "chrome-extension://ehacleppgbekmdjcciihlfinaffoglel/".into(),
    ]
}

/// Development fallback: Chrome extension ids are 32 characters in the `a`–`p`
/// range, which is narrower than "any origin" but still lets a freshly built
/// binary talk to a sideloaded extension before the manifest is installed.
fn plausible_origin(origin: &str) -> bool {
    let Some(rest) = origin.strip_prefix("chrome-extension://") else {
        return false;
    };
    let Some(id) = rest.strip_suffix('/') else {
        return false;
    };
    id.len() == 32 && id.bytes().all(|byte| (b'a'..=b'p').contains(&byte))
}

fn allowed_firefox_extensions() -> Vec<String> {
    if let Ok(path) = std::env::var("BEWLY_IDENTITY_FILE") {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                if let Some(id) = value.get("firefoxExtensionId").and_then(Value::as_str) {
                    return vec![id.to_string()];
                }
            }
        }
    }
    let directory = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()))
        .unwrap_or_default();
    for candidate in [
        directory.join("identity.json"),
        directory.join("../Resources/identity.json"),
        directory.join("../../platforms/identity.json"),
        directory.join("../../../platforms/identity.json"),
    ] {
        if let Ok(text) = std::fs::read_to_string(candidate) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                if let Some(id) = value.get("firefoxExtensionId").and_then(Value::as_str) {
                    return vec![id.to_string()];
                }
            }
        }
    }
    vec!["addon@bewlybewly.com".to_string()]
}

fn origin_allowed(args: &[String]) -> bool {
    let origins = allowed_origins();
    let ff_extensions = allowed_firefox_extensions();

    for arg in args {
        if ff_extensions.iter().any(|id| id == arg) {
            return true;
        }
        if origins.is_empty() {
            if plausible_origin(arg) {
                return true;
            }
        } else if origins.iter().any(|allowed| allowed == arg) {
            return true;
        }
    }
    false
}

fn service_descriptor() -> Option<(u16, String, Option<u32>)> {
    let path = data_directory().join("connection.json");
    let text = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    Some((
        value.get("port")?.as_u64()? as u16,
        value.get("token")?.as_str()?.to_string(),
        value.get("pid").and_then(Value::as_u64).map(|p| p as u32),
    ))
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

fn http_rpc(port: u16, token: &str, payload: &Value, timeout_ms: u64) -> Result<Value, String> {
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::Duration;

    let address = ("127.0.0.1", port)
        .to_socket_addrs()
        .map_err(|error| error.to_string())?
        .next()
        .ok_or("无法解析服务地址")?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(timeout_ms))
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_millis(timeout_ms.max(1000))))
        .ok();
    let body = payload.to_string();
    let request = format!(
        "POST /rpc HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| error.to_string())?;
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or("服务返回了无效响应")?;
    serde_json::from_slice(&response[split + 4..]).map_err(|error| error.to_string())
}

fn start_service(service_mode: &str) -> Result<u32, String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut command = Command::new(exe);
    command
        .arg("--service")
        .env("BEWLY_DOWNLOAD_DATA", data_directory())
        .env("BEWLY_DOWNLOAD_MODE", service_mode)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // The browser runs native hosts in a job object that it closes when the
        // port disconnects, which would end running downloads with it.
        // CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW | DETACHED_PROCESS
        command.creation_flags(0x0900_0008);
        if let Ok(child) = command.spawn() {
            return Ok(child.id());
        }
        // A job without the breakaway permission rejects the flag; start inside it.
        command.creation_flags(0x0800_0008);
    }
    #[cfg(unix)]
    {
        // Its own process group, so a signal to the host's group spares running downloads.
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let child = command.spawn().map_err(|error| error.to_string())?;
    Ok(child.id())
}

fn ensure_service(allow_start: bool) -> Result<(u16, String), Value> {
    if let Some((port, token, pid)) = service_descriptor() {
        if http_rpc(port, &token, &json!({ "method": "health" }), 1000).is_ok() {
            if let Some(p) = pid {
                LAST_SERVICE_PID.store(p, Ordering::Relaxed);
            }
            return Ok((port, token));
        }
    }
    if !allow_start {
        return Err(json!({
            "ok": false,
            "code": "SERVICE_OFFLINE",
            "error": "下载助手当前未运行",
        }));
    }
    let _ = start_service("on-demand");
    for _ in 0..100 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if let Some((port, token, pid)) = service_descriptor() {
            if http_rpc(port, &token, &json!({ "method": "health" }), 1000).is_ok() {
                if let Some(p) = pid {
                    LAST_SERVICE_PID.store(p, Ordering::Relaxed);
                }
                return Ok((port, token));
            }
        }
    }
    Err(json!({
        "ok": false,
        "code": "SERVICE_OFFLINE",
        "error": "本地下载服务启动超时",
    }))
}

fn snapshot_payload() -> Value {
    let path = data_directory().join("ui-snapshot.json");
    match std::fs::read_to_string(path) {
        Ok(text) if text.len() <= 900_000 => match serde_json::from_str::<Value>(&text) {
            Ok(value) => json!({ "ok": true, "result": value }),
            Err(_) => {
                json!({ "ok": false, "code": "SNAPSHOT_MISSING", "error": "本地配置将在首次启动助手时同步" })
            }
        },
        _ => {
            json!({ "ok": false, "code": "SNAPSHOT_MISSING", "error": "本地配置将在首次启动助手时同步" })
        }
    }
}

fn dispatch_rust(message: &Value) -> Value {
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    if method == "bootstrapStatus" {
        let exe = std::env::current_exe()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default();
        return json!({
            "ok": true,
            "result": {
                "connectorVersion": VERSION,
                "runtime": { "ready": true, "version": VERSION, "architecture": std::env::consts::ARCH, "executable": exe },
            },
        });
    }
    if method == "uiSnapshot" {
        return snapshot_payload();
    }
    let allow_start = message.get("allowStart").and_then(Value::as_bool) == Some(true);
    let (port, token) = match ensure_service(allow_start) {
        Ok(descriptor) => descriptor,
        Err(mut error) => {
            if error.get("code").and_then(Value::as_str) == Some("SERVICE_OFFLINE") {
                if let Ok(text) = std::fs::read_to_string(data_directory().join("ui-snapshot.json"))
                {
                    if let Ok(snapshot) = serde_json::from_str::<Value>(&text) {
                        error["snapshot"] = snapshot;
                    }
                }
            }
            return error;
        }
    };
    let mut request = json!({
        "method": method,
        "params": message.get("params").cloned().unwrap_or_else(|| json!({})),
    });
    if let Some(session) = message.get("session") {
        request["session"] = session.clone();
    }
    // A native picker waits on the user, so it gets as long as the browser allows.
    let timeout_ms = if method == "tool"
        && request["params"].get("op").and_then(Value::as_str) == Some("pick")
    {
        600_000
    } else {
        30_000
    };
    DISPATCHING.fetch_add(1, Ordering::SeqCst);
    let rpc_result = http_rpc(port, &token, &request, timeout_ms);
    DISPATCHING.fetch_sub(1, Ordering::SeqCst);
    match rpc_result {
        Ok(mut response) => {
            if response.get("code").and_then(Value::as_str) == Some("SERVICE_STOPPING")
                && allow_start
            {
                std::thread::sleep(std::time::Duration::from_millis(200));
                if let Ok((port, token)) = ensure_service(true) {
                    DISPATCHING.fetch_add(1, Ordering::SeqCst);
                    let retry_result = http_rpc(port, &token, &request, timeout_ms);
                    DISPATCHING.fetch_sub(1, Ordering::SeqCst);
                    if let Ok(retry) = retry_result {
                        response = retry;
                    }
                }
            }
            response
        }
        Err(error) => json!({ "ok": false, "error": format!("无法连接本地服务：{error}") }),
    }
}

#[cfg(windows)]
fn register_platform(chromium_manifest: &Path, firefox_manifest: &Path) -> Result<(), String> {
    let chromium_str = chromium_manifest.to_string_lossy();
    for browser in [
        "Google\\Chrome",
        "Microsoft\\Edge",
        "BraveSoftware\\Brave-Browser",
        "Chromium",
    ] {
        let key = format!("HKCU\\Software\\{browser}\\NativeMessagingHosts\\io.bewly.download");
        let status = Command::new("reg.exe")
            .args([
                "add",
                &key,
                "/ve",
                "/t",
                "REG_SZ",
                "/d",
                &chromium_str,
                "/f",
            ])
            .status()
            .map_err(|error| format!("注册表写入失败: {error}"))?;
        if !status.success() {
            return Err(format!("注册表写入失败: reg.exe 返回 {status}"));
        }
    }

    let firefox_str = firefox_manifest.to_string_lossy();
    let key = "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\io.bewly.download";
    let status = Command::new("reg.exe")
        .args(["add", key, "/ve", "/t", "REG_SZ", "/d", &firefox_str, "/f"])
        .status()
        .map_err(|error| format!("注册表写入失败: {error}"))?;
    if !status.success() {
        return Err(format!("注册表写入失败: reg.exe 返回 {status}"));
    }

    Ok(())
}

#[cfg(windows)]
fn unregister_platform(chromium_manifest: &Path, firefox_manifest: &Path) -> Result<(), String> {
    for browser in [
        "Google\\Chrome",
        "Microsoft\\Edge",
        "BraveSoftware\\Brave-Browser",
        "Chromium",
        "Mozilla",
    ] {
        let key = format!("HKCU\\Software\\{browser}\\NativeMessagingHosts\\io.bewly.download");
        let _ = Command::new("reg.exe")
            .args(["delete", &key, "/f"])
            .status();
    }
    let _ = std::fs::remove_file(chromium_manifest);
    let _ = std::fs::remove_file(firefox_manifest);
    Ok(())
}

#[cfg(target_os = "macos")]
fn chromium_manifest_paths() -> Vec<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let app_support = PathBuf::from(home)
        .join("Library")
        .join("Application Support");
    vec![
        app_support
            .join("Google")
            .join("Chrome")
            .join("NativeMessagingHosts")
            .join("io.bewly.download.json"),
        app_support
            .join("Microsoft Edge")
            .join("NativeMessagingHosts")
            .join("io.bewly.download.json"),
        app_support
            .join("Chromium")
            .join("NativeMessagingHosts")
            .join("io.bewly.download.json"),
        app_support
            .join("BraveSoftware")
            .join("Brave-Browser")
            .join("NativeMessagingHosts")
            .join("io.bewly.download.json"),
    ]
}

#[cfg(target_os = "macos")]
fn firefox_manifest_paths() -> Vec<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let app_support = PathBuf::from(home)
        .join("Library")
        .join("Application Support");
    vec![app_support
        .join("Mozilla")
        .join("NativeMessagingHosts")
        .join("io.bewly.download.json")]
}

#[cfg(target_os = "linux")]
fn chromium_manifest_paths() -> Vec<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let config = match std::env::var("XDG_CONFIG_HOME") {
        Ok(dir) => PathBuf::from(dir),
        Err(_) => PathBuf::from(home).join(".config"),
    };
    vec![
        config
            .join("google-chrome")
            .join("NativeMessagingHosts")
            .join("io.bewly.download.json"),
        config
            .join("chromium")
            .join("NativeMessagingHosts")
            .join("io.bewly.download.json"),
        config
            .join("microsoft-edge")
            .join("NativeMessagingHosts")
            .join("io.bewly.download.json"),
        config
            .join("BraveSoftware")
            .join("Brave-Browser")
            .join("NativeMessagingHosts")
            .join("io.bewly.download.json"),
    ]
}

#[cfg(target_os = "linux")]
fn firefox_manifest_paths() -> Vec<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    vec![PathBuf::from(home)
        .join(".mozilla")
        .join("native-messaging-hosts")
        .join("io.bewly.download.json")]
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn register_platform(chromium_manifest: &Path, firefox_manifest: &Path) -> Result<(), String> {
    let chromium_bytes = std::fs::read(chromium_manifest).map_err(|error| error.to_string())?;
    for target in chromium_manifest_paths() {
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&target, &chromium_bytes);
    }
    let firefox_bytes = std::fs::read(firefox_manifest).map_err(|error| error.to_string())?;
    for target in firefox_manifest_paths() {
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&target, &firefox_bytes);
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn unregister_platform(chromium_manifest: &Path, firefox_manifest: &Path) -> Result<(), String> {
    for target in chromium_manifest_paths() {
        let _ = std::fs::remove_file(&target);
    }
    for target in firefox_manifest_paths() {
        let _ = std::fs::remove_file(&target);
    }
    let _ = std::fs::remove_file(chromium_manifest);
    let _ = std::fs::remove_file(firefox_manifest);
    Ok(())
}

#[cfg(all(not(windows), not(target_os = "macos"), not(target_os = "linux")))]
fn register_platform(_chromium_manifest: &Path, _firefox_manifest: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(all(not(windows), not(target_os = "macos"), not(target_os = "linux")))]
fn unregister_platform(chromium_manifest: &Path, firefox_manifest: &Path) -> Result<(), String> {
    let _ = std::fs::remove_file(chromium_manifest);
    let _ = std::fs::remove_file(firefox_manifest);
    Ok(())
}

#[allow(dead_code)]
fn write_native_manifest(data_dir: &Path, exe: &Path) -> Result<(PathBuf, PathBuf), String> {
    write_native_manifests(data_dir, exe)
}

fn write_native_manifests(data_dir: &Path, exe: &Path) -> Result<(PathBuf, PathBuf), String> {
    let manifest_path = data_dir.join("native-host.json");
    let manifest = json!({
        "name": "io.bewly.download",
        "description": "Bewly local download core",
        "path": exe.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": allowed_origins(),
    });
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
    std::fs::write(&manifest_path, &manifest_bytes).map_err(|error| error.to_string())?;

    let firefox_manifest_path = data_dir.join("native-host-firefox.json");
    let firefox_manifest = json!({
        "name": "io.bewly.download",
        "description": "Bewly local download core",
        "path": exe.to_string_lossy(),
        "type": "stdio",
        "allowed_extensions": allowed_firefox_extensions(),
    });
    let firefox_manifest_bytes =
        serde_json::to_vec_pretty(&firefox_manifest).map_err(|error| error.to_string())?;
    std::fs::write(&firefox_manifest_path, &firefox_manifest_bytes)
        .map_err(|error| error.to_string())?;

    Ok((manifest_path, firefox_manifest_path))
}

fn register() -> Result<(), String> {
    let data_dir = data_directory();
    std::fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let (manifest_path, firefox_manifest_path) = write_native_manifests(&data_dir, &exe)?;
    register_platform(&manifest_path, &firefox_manifest_path)?;
    println!("注册成功：{}", manifest_path.display());
    println!("Firefox 注册成功：{}", firefox_manifest_path.display());
    Ok(())
}

fn unregister() -> Result<(), String> {
    let manifest_path = data_directory().join("native-host.json");
    let firefox_manifest_path = data_directory().join("native-host-firefox.json");
    unregister_platform(&manifest_path, &firefox_manifest_path)?;
    println!("注销成功");
    Ok(())
}
fn run_stdio(args: &[String]) -> i32 {
    if !origin_allowed(args) {
        // Chromium treats any byte on stdout as a protocol violation.
        return 2;
    }
    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    let stdout = std::io::stdout();
    let writer = Arc::new(std::sync::Mutex::new(stdout));

    let watcher_writer = writer.clone();
    let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let watcher_stopped = stopped.clone();

    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
        if watcher_stopped.load(Ordering::Relaxed) {
            break;
        }
        let pid = LAST_SERVICE_PID.load(Ordering::Relaxed);
        if pid == 0 || DISPATCHING.load(Ordering::Relaxed) > 0 {
            continue;
        }
        if !is_pid_alive(pid) {
            LAST_SERVICE_PID.store(0, Ordering::Relaxed);
            let snapshot = match std::fs::read_to_string(data_directory().join("ui-snapshot.json"))
            {
                Ok(text) => serde_json::from_str::<Value>(&text).unwrap_or(Value::Null),
                Err(_) => Value::Null,
            };
            let mut event_msg = json!({ "event": "serviceStopped" });
            if !snapshot.is_null() {
                event_msg["snapshot"] = snapshot;
            }
            if let Ok(payload) = serde_json::to_vec(&event_msg) {
                if let Ok(mut out) = watcher_writer.lock() {
                    let _ = write_frame(&mut *out, &payload);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
            std::process::exit(0);
        }
    });

    loop {
        let frame = match read_frame(&mut reader) {
            Ok(Some(frame)) => frame,
            Ok(None) => {
                stopped.store(true, Ordering::Relaxed);
                return 0;
            }
            Err(_) => {
                stopped.store(true, Ordering::Relaxed);
                return 1;
            }
        };
        let message: Value = match serde_json::from_slice(&frame) {
            Ok(value) => value,
            Err(_) => {
                let payload = serde_json::to_vec(&json!({ "ok": false, "error": "请求格式无效" }))
                    .unwrap_or_default();
                if let Ok(mut out) = writer.lock() {
                    let _ = write_frame(&mut *out, &payload);
                }
                continue;
            }
        };
        let mut response = dispatch_rust(&message);
        if let Some(request_id) = message.get("requestId") {
            response["requestId"] = request_id.clone();
        }
        let mut payload = serde_json::to_vec(&response).unwrap_or_default();
        if payload.len() > 1_000_000 {
            payload = serde_json::to_vec(&json!({ "ok": false, "error": "任务列表过大" }))
                .unwrap_or_default();
        }
        if let Ok(mut out) = writer.lock() {
            if write_frame(&mut *out, &payload).is_err() {
                stopped.store(true, Ordering::Relaxed);
                return 1;
            }
        } else {
            stopped.store(true, Ordering::Relaxed);
            return 1;
        }
    }
}

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    let first = arguments.get(1).map(String::as_str).unwrap_or("");
    if first == "--service" || first == "--daemon" {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("tokio runtime");
        let result = runtime.block_on(bewly_service::run(data_directory(), mode()));
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    if first == "--start-service" {
        let service_mode = if arguments.iter().any(|arg| arg == "--on-demand") {
            "on-demand"
        } else {
            "manual"
        };
        match start_service(service_mode) {
            Ok(pid) => println!("{{\"pid\":{pid}}}"),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    if first == "--version" {
        println!("bewly-host {VERSION}");
        return;
    }
    let is_gui_launch = first.is_empty() || first.starts_with("-psn_");
    if first == "--register" || first == "--install" || is_gui_launch {
        if let Err(error) = register() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        if is_gui_launch {
            let _ = start_service("manual");
        }
        return;
    }
    if first == "--unregister" || first == "--uninstall" {
        if let Err(error) = unregister() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    if first.starts_with("chrome-extension://")
        || first.ends_with(".json")
        || arguments
            .iter()
            .skip(1)
            .any(|a| a == "addon@bewlybewly.com" || a.contains('@'))
    {
        std::process::exit(run_stdio(&arguments[1..]));
    }
    eprintln!(
        "bewly-host {VERSION}\nusage: bewly-host <chrome-extension-origin> | <manifest-path> <firefox-extension-id> | --service | --daemon | --start-service | --register | --install | --unregister | --uninstall"
    );
    std::process::exit(2);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_origin_allowed() {
        assert!(origin_allowed(&[
            "chrome-extension://knnflmlfhhiajbjolfbgkjiadnpmmlcn/".into()
        ]));
        assert!(origin_allowed(&["addon@bewlybewly.com".into()]));
        assert!(origin_allowed(&[
            "native-host-firefox.json".into(),
            "addon@bewlybewly.com".into()
        ]));
        assert!(!origin_allowed(&[
            "chrome-extension://invalidorigin12345/".into()
        ]));
        assert!(!origin_allowed(&[
            "native-host-firefox.json".into(),
            "evil@extension.com".into()
        ]));
    }
}
