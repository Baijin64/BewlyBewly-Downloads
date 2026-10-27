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
