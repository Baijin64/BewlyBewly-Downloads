//! Single binary with several entry points:
//!   `--service`  run the loopback RPC service
//!   `--start-service` spawn a detached service and print `{ "pid": n }`
//!   `chrome-extension://…` native messaging host on stdio
//!   anything else prints usage

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

use bewly_proto::frame::{read_frame, write_frame};
use serde_json::{json, Value};

const VERSION: &str = "0.2.8";

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
                return origins;
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
                return origins;
            }
        }
    }
    Vec::new()
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

fn origin_allowed(origin: &str) -> bool {
    let origins = allowed_origins();
    if origins.is_empty() {
        return plausible_origin(origin);
    }
    origins.iter().any(|allowed| allowed == origin)
}

fn service_descriptor() -> Option<(u16, String)> {
    let path = data_directory().join("connection.json");
    let text = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    Some((
        value.get("port")?.as_u64()? as u16,
        value.get("token")?.as_str()?.to_string(),
    ))
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

fn start_service() -> Result<u32, String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut command = Command::new(exe);
    command
        .arg("--service")
        .env("BEWLY_DOWNLOAD_DATA", data_directory())
        .env("BEWLY_DOWNLOAD_MODE", "on-demand")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0008); // CREATE_NO_WINDOW | DETACHED_PROCESS
    }
    let child = command.spawn().map_err(|error| error.to_string())?;
    Ok(child.id())
}

fn ensure_service(allow_start: bool) -> Result<(u16, String), Value> {
    if let Some(descriptor) = service_descriptor() {
        if http_rpc(
            descriptor.0,
            &descriptor.1,
            &json!({ "method": "health" }),
            1000,
        )
        .is_ok()
        {
            return Ok(descriptor);
        }
    }
    if !allow_start {
        return Err(json!({
            "ok": false,
            "code": "SERVICE_OFFLINE",
            "error": "下载助手当前未运行",
        }));
    }
    let _ = start_service();
    for _ in 0..100 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if let Some(descriptor) = service_descriptor() {
            if http_rpc(
                descriptor.0,
                &descriptor.1,
                &json!({ "method": "health" }),
                1000,
            )
            .is_ok()
            {
                return Ok(descriptor);
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
    let request = json!({ "method": method, "params": message.get("params").cloned().unwrap_or_else(|| json!({})) });
    match http_rpc(port, &token, &request, 30_000) {
        Ok(mut response) => {
            if response.get("code").and_then(Value::as_str) == Some("SERVICE_STOPPING")
                && allow_start
            {
                std::thread::sleep(std::time::Duration::from_millis(200));
                if let Ok((port, token)) = ensure_service(true) {
                    if let Ok(retry) = http_rpc(port, &token, &request, 30_000) {
                        response = retry;
                    }
                }
            }
            response
        }
        Err(error) => json!({ "ok": false, "error": format!("无法连接本地服务：{error}") }),
    }
}

fn run_stdio(origin: &str) -> i32 {
    if !origin_allowed(origin) {
        // Chromium treats any byte on stdout as a protocol violation.
        return 2;
    }
    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    let stdout = std::io::stdout();
    let mut writer = stdout.lock();
    loop {
        let frame = match read_frame(&mut reader) {
            Ok(Some(frame)) => frame,
            Ok(None) => return 0,
            Err(_) => return 1,
        };
        let message: Value = match serde_json::from_slice(&frame) {
            Ok(value) => value,
            Err(_) => {
                let payload = serde_json::to_vec(&json!({ "ok": false, "error": "请求格式无效" }))
                    .unwrap_or_default();
                let _ = write_frame(&mut writer, &payload);
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
        if write_frame(&mut writer, &payload).is_err() {
            return 1;
        }
    }
}

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    let first = arguments.get(1).map(String::as_str).unwrap_or("");
    if first == "--service" {
        let runtime = tokio::runtime::Builder::new_multi_thread()
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
        match start_service() {
            Ok(pid) => println!("{{\"pid\":{pid}}}"),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    if first.starts_with("chrome-extension://") {
        std::process::exit(run_stdio(first));
    }
    eprintln!("bewly-host {VERSION}\nusage: bewly-host <chrome-extension-origin> | --service | --start-service");
    std::process::exit(2);
}
