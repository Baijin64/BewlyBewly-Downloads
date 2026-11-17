// Pause followed straight away by resume must restart the download.
//
// A local range server throttles every connection like a slow mobile link.
// Before the fix, Pause only raised a flag and the old run kept streaming; the
// resumed task sat in `queued` until the old run left, and that run then wrote
// `paused` over the resume, so the user had to click Resume a second time.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const TOTAL: u64 = 128 * 1024 * 1024;
/// Bytes per second each connection is allowed.
const RATE: u64 = 1024 * 1024;

fn temp_directory(tag: &str) -> std::path::PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path =
        std::env::temp_dir().join(format!("bewly-pause-{tag}-{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn serve(stream: TcpStream) {
    let mut stream = stream;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).unwrap_or(0) == 0 {
            return;
        }
        head.push(byte[0]);
    }
    let text = String::from_utf8_lossy(&head).to_string();
    let range = text.lines().find_map(|line| {
        line.to_ascii_lowercase()
            .strip_prefix("range: bytes=")
            .map(str::to_string)
    });
    let (start, end) = match range {
        Some(spec) => {
            let mut parts = spec.trim().split('-');
            let start: u64 = parts.next().unwrap().parse().unwrap();
            let end: u64 = parts.next().unwrap().parse().unwrap();
            (start, end.min(TOTAL - 1))
        }
        None => (0, TOTAL - 1),
    };
    let length = end - start + 1;
    let header = format!(
        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{end}/{TOTAL}\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(header.as_bytes()).is_err() {
        return;
    }
    let chunk = vec![7u8; 64 * 1024];
    let mut sent = 0u64;
    while sent < length {
        let n = (length - sent).min(chunk.len() as u64) as usize;
        if stream.write_all(&chunk[..n]).is_err() {
            return;
        }
        sent += n as u64;
        // A probe (0-0) is a single byte; only throttle real payload.
        if length > 1024 {
            std::thread::sleep(Duration::from_millis(1000 * n as u64 / RATE));
        }
    }
}

fn http_rpc(port: u16, token: &str, payload: &Value) -> Value {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(10))).ok();
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

fn call(port: u16, token: &str, method: &str, params: Value) -> Value {
    http_rpc(port, token, &json!({ "method": method, "params": params }))
}

fn task_view(port: u16, token: &str, id: &str) -> (String, u64, String) {
    let reply = call(port, token, "queryTasks", json!({ "tab": "all" }));
    let item = reply["result"]["items"]
        .as_array()
        .and_then(|items| items.iter().find(|task| task["id"] == id))
        .cloned()
        .unwrap_or(Value::Null);
    (
        item["status"].as_str().unwrap_or("?").to_string(),
        item["progress"].as_u64().unwrap_or(0),
        item["error"].as_str().unwrap_or("").to_string(),
    )
}

struct Service {
    child: std::process::Child,
    stop: Arc<AtomicBool>,
}

impl Drop for Service {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn start() -> (Service, u16, String, u16) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let media_port = listener.local_addr().unwrap().port();
    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = stop.clone();
        listener.set_nonblocking(true).unwrap();
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        stream.set_nonblocking(false).ok();
                        std::thread::spawn(move || serve(stream));
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(10)),
                }
            }
        });
    }

    let directory = temp_directory("service");
    let child = Command::new(env!("CARGO_BIN_EXE_bewly-host"))
        .arg("--service")
        .env("BEWLY_DOWNLOAD_DATA", &directory)
        .env("BEWLY_DOWNLOAD_MODE", "manual")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let service = Service { child, stop };
    let descriptor_path = directory.join("connection.json");
    let deadline = Instant::now() + Duration::from_secs(10);
    let descriptor: Value = loop {
        if let Ok(text) = std::fs::read_to_string(&descriptor_path) {
            if let Ok(value) = serde_json::from_str(&text) {
                break value;
            }
        }
        assert!(Instant::now() < deadline, "no descriptor");
        std::thread::sleep(Duration::from_millis(50));
    };
    let port = descriptor["port"].as_u64().unwrap() as u16;
    let token = descriptor["token"].as_str().unwrap().to_string();
    (service, port, token, media_port)
}

fn wait_for(
    port: u16,
    token: &str,
    id: &str,
    limit: Duration,
    mut done: impl FnMut(&str, u64) -> bool,
) -> String {
    let begin = Instant::now();
    loop {
        let (status, progress, error) = task_view(port, token, id);
        assert!(
            status != "failed",
            "task failed: {error} (after {:?})",
            begin.elapsed()
        );
        if done(&status, progress) {
            return status;
        }
        assert!(
            begin.elapsed() < limit,
            "still `{status}` {progress}% after {limit:?}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn resume_right_after_pause_restarts_the_download() {
    let (_service, port, token, media_port) = start();

    // One slot, so a run that is still draining would also block every other task.
    call(port, &token, "configure", json!({ "maxConcurrent": 1 }));

    let info = json!({
        "bvid": "BV1xx411c7mD", "title": "pause-resume", "author": "UP", "cover": "", "uid": 1,
        "pubdate": 1700000000, "description": "",
        "pages": [{ "cid": 11, "page": 1, "title": "P1", "duration": 10 }]
    });
    let prepared = json!({ "video": {
        "urls": [format!("http://127.0.0.1:{media_port}/v.m4s")], "quality": 80, "codec": 7
    }});
    let created = call(
        port,
        &token,
        "createTasks",
        json!({
            "info": info,
            "cids": [11],
            "options": { "outputs": ["silent"] },
            "prepared": { "11": prepared.clone() }
        }),
    );
    assert_eq!(created["ok"], true, "{created}");
    let id = created["result"][0]["id"].as_str().unwrap().to_string();

    // Wait until bytes are really flowing.
    wait_for(
        port,
        &token,
        &id,
        Duration::from_secs(30),
        |status, progress| status == "downloading" && progress > 0,
    );

    for round in 0..3 {
        let paused = call(
            port,
            &token,
            "taskAction",
            json!({ "id": id, "action": "pause" }),
        );
        assert_eq!(paused["result"]["status"], "paused", "round {round}");
        let resumed = call(
            port,
            &token,
            "taskAction",
            json!({ "id": id, "action": "resume", "prepared": prepared.clone() }),
        );
        assert_eq!(resumed["result"]["status"], "queued", "round {round}");

        // The old run drains within a read slice and the new one starts at once.
        // It must never fall back to `paused`: that would mean the old run
        // overwrote the resume.
        let started = Instant::now();
        let status = wait_for(port, &token, &id, Duration::from_secs(8), |status, _| {
            assert_ne!(status, "paused", "round {round}: the resume was lost");
            status == "downloading"
        });
        assert_eq!(status, "downloading");
        assert!(
            started.elapsed() < Duration::from_secs(6),
            "round {round}: restart took {:?}",
            started.elapsed()
        );
        std::thread::sleep(Duration::from_millis(300));
    }

    // A plain pause still sticks while the old run winds down.
    let paused = call(
        port,
        &token,
        "taskAction",
        json!({ "id": id, "action": "pause" }),
    );
    assert_eq!(paused["result"]["status"], "paused");
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        let (status, _, error) = task_view(port, &token, &id);
        assert_eq!(status, "paused", "pause was undone ({error})");
        std::thread::sleep(Duration::from_millis(50));
    }

    // And a cancel is not turned into a pause by the draining run.
    let resumed = call(
        port,
        &token,
        "taskAction",
        json!({ "id": id, "action": "resume", "prepared": prepared.clone() }),
    );
    assert_eq!(resumed["result"]["status"], "queued");
    wait_for(port, &token, &id, Duration::from_secs(8), |status, _| {
        status == "downloading"
    });
    let cancelled = call(
        port,
        &token,
        "taskAction",
        json!({ "id": id, "action": "cancel" }),
    );
    assert_eq!(cancelled["result"]["status"], "cancelled");
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        let (status, _, error) = task_view(port, &token, &id);
        assert_eq!(status, "cancelled", "cancel was undone ({error})");
        std::thread::sleep(Duration::from_millis(50));
    }
}
