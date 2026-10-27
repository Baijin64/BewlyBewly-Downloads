// End-to-end checks against the real binaries: the stdio host must speak the
// framing contract, and the service must answer RPC on loopback.

use std::io::{BufReader, Read, Write};
use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use bewly_proto::frame::{read_frame, write_frame};
use serde_json::{json, Value};

fn host_binary() -> &'static str {
    env!("CARGO_BIN_EXE_bewly-host")
}

fn temp_directory(tag: &str) -> std::path::PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "bewly-host-test-{tag}-{}-{stamp}",
        std::process::id()
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn identity_file(directory: &std::path::Path) -> std::path::PathBuf {
    let path = directory.join("identity.json");
    std::fs::write(
        &path,
        json!({
            "extensionId": "abcdefghijklmnopabcdefghijklmnop",
            "legacyExtensionIds": []
        })
        .to_string(),
    )
    .unwrap();
    path
}

fn request(reader: &mut impl Read, writer: &mut impl Write, message: Value) -> Value {
    let payload = serde_json::to_vec(&message).unwrap();
    write_frame(writer, &payload).unwrap();
    let reply = read_frame(reader).unwrap().expect("reply frame");
    serde_json::from_slice(&reply).unwrap()
}

#[test]
fn stdio_host_answers_bootstrap_and_snapshot_without_starting_a_service() {
    let directory = temp_directory("stdio");
    let identity = identity_file(&directory);
    let data = directory.join("data");
    let mut child = Command::new(host_binary())
        .arg("chrome-extension://abcdefghijklmnopabcdefghijklmnop/")
        .env("BEWLY_DOWNLOAD_DATA", &data)
        .env("BEWLY_IDENTITY_FILE", &identity)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());

    let bootstrap = request(
        &mut stdout,
        &mut stdin,
        json!({ "method": "bootstrapStatus", "requestId": 7 }),
    );
    assert_eq!(bootstrap["ok"], true);
    assert_eq!(bootstrap["requestId"], 7);
    assert_eq!(bootstrap["result"]["connectorVersion"], "0.2.8");
    assert_eq!(bootstrap["result"]["runtime"]["ready"], true);

    let snapshot = request(
        &mut stdout,
        &mut stdin,
        json!({ "method": "uiSnapshot", "requestId": "s" }),
    );
    assert_eq!(snapshot["ok"], false);
    assert_eq!(snapshot["code"], "SNAPSHOT_MISSING");
    assert!(
        !data.exists(),
        "the snapshot fast path must not create the data directory"
    );

    drop(stdin);
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(0));
}

#[test]
fn stdio_host_rejects_foreign_origins_silently() {
    let directory = temp_directory("origin");
    let identity = identity_file(&directory);
    let output = Command::new(host_binary())
        .arg("chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/")
        .env("BEWLY_DOWNLOAD_DATA", directory.join("data"))
        .env("BEWLY_IDENTITY_FILE", &identity)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty(), "stdout must stay empty");
}

fn http_rpc(port: u16, token: &str, payload: &Value) -> Value {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    let body = payload.to_string();
    let request = format!(
        "POST /rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).unwrap();
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("headers");
    serde_json::from_slice(&response[split + 4..]).unwrap()
}

#[test]
fn service_answers_health_and_queries_on_loopback() {
    let directory = temp_directory("service");
    let mut child = Command::new(host_binary())
        .arg("--service")
        .env("BEWLY_DOWNLOAD_DATA", &directory)
        .env("BEWLY_DOWNLOAD_MODE", "manual")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    let descriptor_path = directory.join("connection.json");
    let deadline = Instant::now() + Duration::from_secs(10);
    let descriptor: Value = loop {
        if let Ok(text) = std::fs::read_to_string(&descriptor_path) {
            if let Ok(value) = serde_json::from_str(&text) {
                break value;
            }
        }
        assert!(
            Instant::now() < deadline,
            "service did not publish a descriptor"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    let port = descriptor["port"].as_u64().unwrap() as u16;
    let token = descriptor["token"].as_str().unwrap();

    let health = http_rpc(port, token, &json!({ "method": "health", "params": {} }));
    assert_eq!(health["ok"], true);
    assert_eq!(health["result"]["protocol"], 2);
    assert_eq!(health["result"]["settings"]["maxConcurrent"], 2);

    let configured = http_rpc(
        port,
        token,
        &json!({ "method": "configure", "params": { "maxConcurrent": 3 } }),
    );
    assert_eq!(configured["result"]["maxConcurrent"], 3);

    let tasks = http_rpc(
        port,
        token,
        &json!({ "method": "queryTasks", "params": { "tab": "all" } }),
    );
    assert_eq!(tasks["result"]["total"], 0);
    assert_eq!(tasks["result"]["counts"]["pending"], 0);

    let rejected = {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let body = json!({ "method": "health" }).to_string();
        let request = format!(
            "POST /rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer wrong\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    };
    assert!(rejected.starts_with("HTTP/1.1 403"));

    let _ = child.kill();
    let _ = child.wait();
}

#[allow(clippy::zombie_processes)]
fn start_service(
    directory: &std::path::Path,
    grace_ms: &str,
) -> (std::process::Child, u16, String) {
    let child = Command::new(host_binary())
        .arg("--service")
        .env("BEWLY_DOWNLOAD_DATA", directory)
        .env("BEWLY_DOWNLOAD_MODE", "on-demand")
        .env("BEWLY_IDLE_GRACE_MS", grace_ms)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let descriptor_path = directory.join("connection.json");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(text) = std::fs::read_to_string(&descriptor_path) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                let port = value["port"].as_u64().unwrap() as u16;
                let token = value["token"].as_str().unwrap().to_string();
                return (child, port, token);
            }
        }
        assert!(
            Instant::now() < deadline,
            "service did not publish a descriptor"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn call(port: u16, token: &str, method: &str, params: Value) -> Value {
    http_rpc(port, token, &json!({ "method": method, "params": params }))
}

#[test]
fn task_lifecycle_tools_and_idle_exit_work_over_rpc() {
    let directory = temp_directory("lifecycle");
    let (mut child, port, token) = start_service(&directory, "400");

    let info = json!({
        "bvid": "BV1xx411c7mD",
        "title": "测试视频",
        "author": "UP",
        "cover": "",
        "uid": 1,
        "pubdate": 1700000000,
        "description": "",
        "pages": [{ "cid": 11, "page": 1, "title": "P1", "duration": 10 }]
    });
    let staged = call(
        port,
        &token,
        "stageTasks",
        json!({ "info": info, "cids": [11], "options": {} }),
    );
    assert_eq!(staged["ok"], true);
    assert_eq!(staged["result"][0]["status"], "pending");
    assert!(staged["result"][0].get("prepared").is_none());
    let id = staged["result"][0]["id"].as_str().unwrap().to_string();

    let started = call(
        port,
        &token,
        "taskAction",
        json!({ "id": id, "action": "start" }),
    );
    assert_eq!(started["result"]["status"], "queued");

    let paused = call(
        port,
        &token,
        "taskAction",
        json!({ "id": id, "action": "pause" }),
    );
    assert_eq!(paused["result"]["status"], "paused");

    let resumed = call(
        port,
        &token,
        "taskAction",
        json!({ "id": id, "action": "resume" }),
    );
    assert_eq!(resumed["result"]["status"], "queued");

    let job = call(
        port,
        &token,
        "tool",
        json!({ "op": "convertId", "input": "av170001" }),
    );
    assert_eq!(job["ok"], true);
    assert_eq!(job["result"]["status"], "completed");
    assert_eq!(job["result"]["result"]["text"], "BV17x411w7KC");
    let job_id = job["result"]["id"].as_str().unwrap().to_string();
    let status = call(
        port,
        &token,
        "tool",
        json!({ "op": "status", "id": job_id }),
    );
    assert_eq!(status["result"]["status"], "completed");

    let counts = call(port, &token, "queryTasks", json!({ "tab": "all" }));
    assert_eq!(counts["result"]["counts"]["active"], 1);

    // Cancelling removes the only busy task, so the idle lease starts counting.
    let cancelled = call(
        port,
        &token,
        "taskAction",
        json!({ "id": id, "action": "cancel" }),
    );
    assert_eq!(cancelled["result"]["status"], "cancelled");

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            assert_eq!(status.code(), Some(0));
            break;
        }
        assert!(Instant::now() < deadline, "on-demand service did not exit");
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(
        !directory.join("connection.json").exists(),
        "descriptor must be removed on exit"
    );
}

#[test]
fn migration_previews_and_imports_legacy_settings() {
    let directory = temp_directory("migration");
    let mut child = Command::new(host_binary())
        .arg("--service")
        .env("BEWLY_DOWNLOAD_DATA", &directory)
        .env("BEWLY_DOWNLOAD_MODE", "manual")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let descriptor_path = directory.join("connection.json");
    let deadline = Instant::now() + Duration::from_secs(10);
    let descriptor: Value = loop {
        if let Ok(text) = std::fs::read_to_string(&descriptor_path) {
            if let Ok(value) = serde_json::from_str(&text) {
                break value;
            }
        }
        assert!(
            Instant::now() < deadline,
            "service did not publish a descriptor"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    let port = descriptor["port"].as_u64().unwrap() as u16;
    let token = descriptor["token"].as_str().unwrap().to_string();

    // The service expects a browser profile root, not the leveldb directory.
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../bewly-store/tests/fixtures/localstorage-leveldb");
    let profile = directory.join("profile");
    let leveldb = profile.join("Local Storage").join("leveldb");
    std::fs::create_dir_all(&leveldb).unwrap();
    for entry in std::fs::read_dir(&fixture).unwrap().flatten() {
        let name = entry.file_name();
        if name.to_string_lossy() == "LOCK" {
            continue;
        }
        std::fs::copy(entry.path(), leveldb.join(name)).unwrap();
    }
    let preview = call(
        port,
        &token,
        "migrationPreview",
        json!({ "profile": profile.to_string_lossy() }),
    );
    assert_eq!(preview["ok"], true, "{preview}");
    let id = preview["result"]["id"].as_str().unwrap().to_string();
    let changes = preview["result"]["changes"].as_array().unwrap();
    assert!(changes
        .iter()
        .any(|change| change["key"] == "maxConcurrent"));
    assert_eq!(preview["result"]["warnings"].as_array().unwrap().len(), 2);

    let imported = call(
        port,
        &token,
        "migrationImport",
        json!({ "id": id, "keys": ["maxConcurrent", "defaultOptions"] }),
    );
    assert_eq!(imported["ok"], true, "{imported}");
    assert_eq!(imported["result"]["settings"], 2);

    let health = call(port, &token, "health", json!({}));
    assert_eq!(health["result"]["settings"]["maxConcurrent"], 4);
    assert_eq!(
        health["result"]["settings"]["defaultOptions"]["quality"],
        112
    );

    let _ = child.kill();
    let _ = child.wait();
}

fn mock_bilibili() -> (u16, std::thread::JoinHandle<()>) {
    use std::net::TcpListener;
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buffer = [0u8; 2048];
            let _ = stream.read(&mut buffer);
            let body = json!({
                "code": 0,
                "data": {
                    "bvid": "BV17x411w7KC",
                    "title": "测试视频",
                    "owner": { "name": "UP主", "mid": 42 },
                    "pubdate": 1700000000,
                    "desc": "简介",
                    "pic": "https://i0.hdslb.com/a.jpg",
                    "pages": [
                        { "cid": 11, "page": 1, "part": "P1", "duration": 10 },
                        { "cid": 12, "page": 2, "part": "P2", "duration": 11 }
                    ]
                }
            })
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
    (port, handle)
}

#[test]
fn inspect_reads_the_view_api_and_expand_passes_regular_urls() {
    let directory = temp_directory("inspect");
    let (api_port, mock) = mock_bilibili();
    let mut child = Command::new(host_binary())
        .arg("--service")
        .env("BEWLY_DOWNLOAD_DATA", &directory)
        .env("BEWLY_DOWNLOAD_MODE", "manual")
        .env("BEWLY_API_BASE", format!("http://127.0.0.1:{api_port}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let descriptor_path = directory.join("connection.json");
    let deadline = Instant::now() + Duration::from_secs(10);
    let descriptor: Value = loop {
        if let Ok(text) = std::fs::read_to_string(&descriptor_path) {
            if let Ok(value) = serde_json::from_str(&text) {
                break value;
            }
        }
        assert!(
            Instant::now() < deadline,
            "service did not publish a descriptor"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    let port = descriptor["port"].as_u64().unwrap() as u16;
    let token = descriptor["token"].as_str().unwrap();

    let inspected = call(
        port,
        token,
        "inspect",
        json!({ "video": "https://www.bilibili.com/video/BV17x411w7KC/?p=2" }),
    );
    assert_eq!(inspected["ok"], true, "{inspected}");
    assert_eq!(inspected["result"]["title"], "测试视频");
    assert_eq!(inspected["result"]["author"], "UP主");
    assert_eq!(inspected["result"]["requestedPage"], 2);
    assert_eq!(inspected["result"]["pages"].as_array().unwrap().len(), 2);
    assert_eq!(inspected["result"]["pages"][1]["cid"], 12);

    let expanded = call(
        port,
        token,
        "expandLink",
        json!({ "video": "https://www.bilibili.com/video/BV17x411w7KC" }),
    );
    assert_eq!(expanded["ok"], true, "{expanded}");
    assert_eq!(
        expanded["result"],
        "https://www.bilibili.com/video/BV17x411w7KC"
    );

    let _ = mock.join();
    let _ = child.kill();
    let _ = child.wait();
}
