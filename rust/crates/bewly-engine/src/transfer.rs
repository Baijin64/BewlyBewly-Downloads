//! Resumable piece downloader: fixed-size ranges, mirror rotation, retry and a
//! sidecar that records exactly which pieces are trustworthy.

use std::collections::VecDeque;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use thiserror::Error;

use crate::plan::PieceMap;
use crate::sidecar;

pub const PIECE_LENGTH: u32 = 1024 * 1024;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("下载已取消")]
    Cancelled,
    #[error("磁盘空间不足，已保留断点进度")]
    StorageFull,
    #[error("下载失败：{0}")]
    Http(String),
    #[error("写入文件失败：{0}")]
    Io(String),
    #[error("下载结果不完整：{0}")]
    Corrupt(&'static str),
}

fn io_error(error: std::io::Error) -> EngineError {
    match error.raw_os_error() {
        Some(28) | Some(112) => EngineError::StorageFull,
        _ => EngineError::Io(error.to_string()),
    }
}

pub struct Request<'a> {
    pub urls: &'a [String],
    pub destination: &'a Path,
    pub piece_length: u32,
    pub connections: usize,
    pub headers: Vec<(String, String)>,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(30))
        .build()
}

fn request(url: &str, headers: &[(String, String)], range: Option<(u64, u64)>) -> ureq::Request {
    let mut request = agent().get(url);
    for (name, value) in headers {
        request = request.set(name, value);
    }
    match range {
        Some((start, end)) => request.set("Range", &format!("bytes={start}-{end}")),
        None => request,
    }
}

fn content_range_total(value: &str) -> Option<u64> {
    value.rsplit('/').next()?.parse().ok()
}

/// Probes the remote object: total size and whether ranges are honoured.
/// Mirrors are tried in order because a single CDN node may answer 5xx while the
/// backup already serves the same object.
fn probe(urls: &[String], headers: &[(String, String)]) -> Result<(u64, bool), EngineError> {
    let mut last = String::new();
    for attempt in 0..(urls.len() * 2).max(3) {
        let url = &urls[attempt % urls.len()];
        match request(url, headers, Some((0, 0))).call() {
            Ok(response) => {
                let total = response
                    .header("content-range")
                    .and_then(content_range_total)
                    .or_else(|| {
                        response
                            .header("content-length")
                            .and_then(|value| value.parse().ok())
                    })
                    .ok_or(EngineError::Corrupt("缺少长度信息"))?;
                return Ok((total, response.status() == 206));
            }
            Err(ureq::Error::Status(416, _)) => {
                return Err(EngineError::Http("服务器拒绝分段请求".into()))
            }
            Err(error) => last = error.to_string(),
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    Err(EngineError::Http(last))
}

fn write_at(file: &File, mut offset: u64, mut bytes: &[u8]) -> Result<(), EngineError> {
    while !bytes.is_empty() {
        let written = {
            #[cfg(windows)]
            {
                use std::os::windows::fs::FileExt;
                file.seek_write(bytes, offset).map_err(io_error)?
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::FileExt;
                file.write_at(bytes, offset).map_err(io_error)?
            }
        };
        if written == 0 {
            return Err(EngineError::Io("写入返回 0 字节".into()));
        }
        offset += written as u64;
        bytes = &bytes[written..];
    }
    Ok(())
}

fn fetch_piece(
    urls: &[String],
    headers: &[(String, String)],
    range: (u64, u64),
    cursor: usize,
) -> Result<Vec<u8>, EngineError> {
    let expected = (range.1 - range.0 + 1) as usize;
    let mut last = String::new();
    for attempt in 0..urls.len().max(1) * 2 {
        let url = &urls[(cursor + attempt) % urls.len().max(1)];
        match request(url, headers, Some(range)).call() {
            Ok(response) if response.status() == 206 => {
                let mut buffer = Vec::with_capacity(expected);
                response
                    .into_reader()
                    .take(expected as u64)
                    .read_to_end(&mut buffer)
                    .map_err(io_error)?;
                if buffer.len() != expected {
                    last = format!("分段长度不符（{} != {expected}）", buffer.len());
                } else {
                    return Ok(buffer);
                }
            }
            Ok(response) => last = format!("服务器返回 {}", response.status()),
            Err(error) => last = error.to_string(),
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    Err(EngineError::Http(last))
}

/// Downloads `request.destination`, resuming from its sidecar when possible.
pub fn download(
    request_spec: Request<'_>,
    cancel: Arc<AtomicBool>,
    mut progress: impl FnMut(u64, u64) + Send,
) -> Result<PathBuf, EngineError> {
    if request_spec.urls.is_empty() {
        return Err(EngineError::Http("没有可用的下载地址".into()));
    }
    let (total, ranged) = probe(request_spec.urls, &request_spec.headers)?;
    if total == 0 {
        return Err(EngineError::Corrupt("文件长度为 0"));
    }
    let destination = request_spec.destination.to_path_buf();

    if !ranged {
        return sequential(&request_spec, total, &cancel, &mut progress);
    }

    let piece_length = if request_spec.piece_length == 0 {
        PIECE_LENGTH
    } else {
        request_spec.piece_length
    };
    let map = sidecar::load(&destination, total, piece_length)
        .unwrap_or_else(|| PieceMap::new(total, piece_length));
    if map.is_complete() && destination.exists() {
        progress(total, total);
        return Ok(destination);
    }

    let file = File::options()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&destination)
        .map_err(io_error)?;
    file.set_len(total).map_err(io_error)?;

    let map = Arc::new(Mutex::new(map.clone()));
    let queue = Arc::new(Mutex::new(VecDeque::from(map.lock().unwrap().missing())));
    let file = Arc::new(file);
    let completed = Arc::new(AtomicU64::new(map.lock().unwrap().completed_bytes()));
    let failure: Arc<Mutex<Option<EngineError>>> = Arc::new(Mutex::new(None));
    let urls: Arc<Vec<String>> = Arc::new(request_spec.urls.to_vec());
    let headers = Arc::new(request_spec.headers.clone());
    let workers = request_spec.connections.clamp(1, 8);

    let mut handles = Vec::new();
    for index in 0..workers {
        let queue = queue.clone();
        let map = map.clone();
        let file = file.clone();
        let completed = completed.clone();
        let failure = failure.clone();
        let urls = urls.clone();
        let headers = headers.clone();
        let cancel = cancel.clone();
        handles.push(std::thread::spawn(move || loop {
            if cancel.load(Ordering::Relaxed) {
                return;
            }
            let Some(piece) = queue.lock().unwrap().pop_front() else {
                return;
            };
            let range = map.lock().unwrap().range(piece);
            match fetch_piece(&urls, &headers, range, index) {
                Ok(bytes) => {
                    if let Err(error) = write_at(&file, range.0, &bytes) {
                        *failure.lock().unwrap() = Some(error);
                        return;
                    }
                    let mut guard = map.lock().unwrap();
                    guard.mark(piece);
                    let done = guard.completed_bytes();
                    drop(guard);
                    completed.store(done, Ordering::Relaxed);
                }
                Err(error) => {
                    *failure.lock().unwrap() = Some(error);
                    return;
                }
            }
        }));
    }

    let mut last_save = std::time::Instant::now();
    let created = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    loop {
        std::thread::sleep(Duration::from_millis(120));
        progress(completed.load(Ordering::Relaxed), total);
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        if last_save.elapsed() >= Duration::from_secs(2) {
            let guard = map.lock().unwrap();
            let _ = sidecar::save(&destination, &guard, &urls[0], "", &created);
            last_save = std::time::Instant::now();
        }
        if handles.iter().all(|handle| handle.is_finished()) {
            break;
        }
    }
    for handle in handles {
        let _ = handle.join();
    }

    let guard = map.lock().unwrap();
    let _ = sidecar::save(&destination, &guard, &urls[0], "", &created);
    if cancel.load(Ordering::Relaxed) {
        return Err(EngineError::Cancelled);
    }
    if let Some(error) = failure.lock().unwrap().take() {
        return Err(error);
    }
    if !guard.is_complete() {
        return Err(EngineError::Corrupt("仍有分片未完成"));
    }
    drop(guard);

    let length = std::fs::metadata(&destination).map_err(io_error)?.len();
    if length != total {
        return Err(EngineError::Corrupt("文件长度与远端不一致"));
    }
    let _ = std::fs::remove_file(sidecar::path_for(&destination));
    Ok(destination)
}

fn sequential(
    spec: &Request<'_>,
    total: u64,
    cancel: &Arc<AtomicBool>,
    progress: &mut impl FnMut(u64, u64),
) -> Result<PathBuf, EngineError> {
    let response = request(&spec.urls[0], &spec.headers, None)
        .call()
        .map_err(|error| EngineError::Http(error.to_string()))?;
    let mut reader = response.into_reader();
    let mut file = File::create(spec.destination).map_err(io_error)?;
    file.seek(SeekFrom::Start(0)).map_err(io_error)?;
    let mut buffer = vec![0u8; 64 * 1024];
    let mut written = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(EngineError::Cancelled);
        }
        let read = reader.read(&mut buffer).map_err(io_error)?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read]).map_err(io_error)?;
        written += read as u64;
        progress(written, total);
    }
    if written != total {
        return Err(EngineError::Corrupt("文件长度与远端不一致"));
    }
    Ok(spec.destination.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;

    struct Server {
        port: u16,
        stop: Arc<AtomicBool>,
        handle: Option<std::thread::JoinHandle<()>>,
    }

    impl Server {
        fn start(data: Vec<u8>, fail_first: usize) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            let stop = Arc::new(AtomicBool::new(false));
            let flag = stop.clone();
            let handle = std::thread::spawn(move || {
                let mut failures = 0usize;
                for stream in listener.incoming() {
                    if flag.load(Ordering::Relaxed) {
                        break;
                    }
                    let Ok(mut stream) = stream else { break };
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut request_line = String::new();
                    if reader.read_line(&mut request_line).is_err() {
                        continue;
                    }
                    let mut range = None;
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                            break;
                        }
                        if let Some(value) = line.to_ascii_lowercase().strip_prefix("range: bytes=")
                        {
                            let value = value.trim();
                            let (start, end) = value.split_once('-').unwrap_or((value, ""));
                            range = Some((
                                start.parse::<usize>().unwrap_or(0),
                                end.parse::<usize>().ok(),
                            ));
                        }
                    }
                    let failed_so_far = failures;
                    failures += 1;
                    if failed_so_far < fail_first {
                        let _ = stream.write_all(
                            b"HTTP/1.1 500 Oops\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        );
                        continue;
                    }
                    let total = data.len();
                    let (start, end) = match range {
                        Some((start, Some(end))) => (start, end.min(total - 1)),
                        Some((start, None)) => (start, total - 1),
                        None => (0, total - 1),
                    };
                    let body = &data[start..=end];
                    let header = if range.is_some() {
                        format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{end}/{total}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                    } else {
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                    };
                    let _ = stream.write_all(header.as_bytes());
                    let _ = stream.write_all(body);
                }
            });
            Self {
                port,
                stop,
                handle: Some(handle),
            }
        }

        fn url(&self) -> String {
            format!("http://127.0.0.1:{}/file.bin", self.port)
        }
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            let _ = std::net::TcpStream::connect(("127.0.0.1", self.port));
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    fn payload(size: usize) -> Vec<u8> {
        (0..size).map(|index| (index % 251) as u8).collect()
    }

    #[test]
    fn downloads_all_pieces_and_verifies_the_length() {
        let data = payload(8 * 1024);
        let server = Server::start(data.clone(), 0);
        let directory = std::env::temp_dir().join(format!("bewly-transfer-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let destination = directory.join("video.m4s");
        let _ = std::fs::remove_file(&destination);
        let urls = vec![server.url()];
        let result = download(
            Request {
                urls: &urls,
                destination: &destination,
                piece_length: 1024,
                connections: 2,
                headers: vec![],
            },
            Arc::new(AtomicBool::new(false)),
            |_, _| {},
        )
        .unwrap();
        assert_eq!(std::fs::read(result).unwrap(), data);
    }

    #[test]
    fn retries_after_server_errors() {
        let data = payload(4 * 1024);
        let server = Server::start(data.clone(), 2);
        let directory =
            std::env::temp_dir().join(format!("bewly-transfer-retry-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let destination = directory.join("video.m4s");
        let _ = std::fs::remove_file(&destination);
        let urls = vec![server.url()];
        download(
            Request {
                urls: &urls,
                destination: &destination,
                piece_length: 1024,
                connections: 1,
                headers: vec![],
            },
            Arc::new(AtomicBool::new(false)),
            |_, _| {},
        )
        .unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), data);
    }

    #[test]
    fn cancellation_stops_the_transfer() {
        let data = payload(4 * 1024);
        let server = Server::start(data, 0);
        let directory =
            std::env::temp_dir().join(format!("bewly-transfer-cancel-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let destination = directory.join("video.m4s");
        let urls = vec![server.url()];
        let cancel = Arc::new(AtomicBool::new(true));
        let error = download(
            Request {
                urls: &urls,
                destination: &destination,
                piece_length: 1024,
                connections: 1,
                headers: vec![],
            },
            cancel,
            |_, _| {},
        )
        .unwrap_err();
        assert!(matches!(error, EngineError::Cancelled));
    }
}
