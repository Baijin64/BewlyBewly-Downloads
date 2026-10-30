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

/// Attempts per run of pieces before the transfer gives up. With the backoff
/// below this rides out roughly half a minute of network trouble.
const MAX_ATTEMPTS: u32 = 8;
/// Adjacent pieces fetched in one ranged request. Fewer requests means fewer
/// round trips per megabyte; the sidecar still records single pieces.
const RUN_PIECES: usize = 4;

fn agent() -> &'static ureq::Agent {
    static SHARED_AGENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    SHARED_AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            // A stalled connection is dropped, a slow but moving one is not.
            .timeout_read(Duration::from_secs(20))
            // ureq keeps one idle connection per host by default, so parallel
            // workers would redo the TLS handshake for every piece.
            .max_idle_connections(64)
            .max_idle_connections_per_host(16)
            .build()
    })
}

/// Sleeps in short slices so cancellation is not delayed by a backoff.
fn backoff(attempt: u32, cancel: &AtomicBool, worker_abort: &AtomicBool) {
    let total = Duration::from_millis((500u64 << attempt.min(4)).min(8_000));
    let started = std::time::Instant::now();
    while started.elapsed() < total {
        if cancel.load(Ordering::Relaxed) || worker_abort.load(Ordering::Relaxed) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
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

/// Peer-assisted (PCDN) nodes are often slow or drop mid-transfer, so they are
/// tried after the regular CDN mirrors. The order is otherwise kept.
fn prefer_cdn_mirrors(urls: &[String]) -> Vec<String> {
    let is_peer_node = |url: &str| {
        let host = url
            .split("://")
            .nth(1)
            .and_then(|rest| rest.split('/').next())
            .unwrap_or("");
        host.contains(".mcdn.bilivideo.") || host.ends_with(".szbdyd.com") || host.contains(':')
    };
    let mut ordered = urls.to_vec();
    ordered.sort_by_key(|url| is_peer_node(url));
    ordered
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

/// Fetches a run of adjacent pieces with one ranged request, handing each
/// piece to `on_piece` as soon as its bytes arrive. A dropped connection
/// resumes from the first piece not yet delivered, on the next mirror.
#[allow(clippy::too_many_arguments)]
fn fetch_run(
    urls: &[String],
    headers: &[(String, String)],
    run: &[(u64, (u64, u64))],
    cursor: &mut usize,
    buf: &mut Vec<u8>,
    cancel: &AtomicBool,
    worker_abort: &AtomicBool,
    mut on_piece: impl FnMut(u64, (u64, u64), &[u8]) -> Result<(), EngineError>,
) -> Result<(), EngineError> {
    let url_count = urls.len().max(1);
    let mut done = 0usize;
    let mut failures = 0u32;
    let mut refused = 0usize;
    let mut last = String::new();
    while done < run.len() {
        if cancel.load(Ordering::Relaxed) || worker_abort.load(Ordering::Relaxed) {
            return Err(EngineError::Cancelled);
        }
        let range = (run[done].1 .0, run[run.len() - 1].1 .1);
        let url = &urls[*cursor % url_count];
        match request(url, headers, Some(range)).call() {
            Ok(response) if response.status() == 206 => {
                refused = 0;
                let mut reader = response.into_reader();
                let before = done;
                while done < run.len() {
                    let (piece, piece_range) = run[done];
                    let expected = piece_range.1 - piece_range.0 + 1;
                    buf.clear();
                    match (&mut reader).take(expected).read_to_end(buf) {
                        Ok(_) if buf.len() as u64 == expected => {
                            on_piece(piece, piece_range, buf)?;
                            done += 1;
                        }
                        Ok(_) => {
                            last = format!("分段长度不符（{} != {expected}）", buf.len());
                            break;
                        }
                        Err(error) => {
                            last = error.to_string();
                            break;
                        }
                    }
                }
                if done == run.len() {
                    return Ok(());
                }
                if done > before {
                    // The mirror was delivering; this was a dropped connection, not a bad node.
                    failures = 0;
                }
            }
            Ok(response) => last = format!("服务器未按分段返回（{}）", response.status()),
            Err(ureq::Error::Status(code, _)) => {
                if matches!(code, 403 | 404 | 410) {
                    refused += 1;
                }
                last = format!("服务器返回 {code}");
            }
            Err(error) => last = error.to_string(),
        }
        *cursor = (*cursor + 1) % url_count;
        failures += 1;
        // Every mirror refusing means the signed link expired; the caller
        // re-resolves instead of waiting out the backoff.
        if refused >= url_count || failures >= MAX_ATTEMPTS {
            return Err(EngineError::Http(last));
        }
        backoff(failures - 1, cancel, worker_abort);
    }
    Ok(())
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
    let mirrors = prefer_cdn_mirrors(request_spec.urls);
    let (total, ranged) = probe(&mirrors, &request_spec.headers)?;
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
    let aria2_path = {
        let mut p = destination.as_os_str().to_os_string();
        p.push(".aria2");
        PathBuf::from(p)
    };
    let map = sidecar::load(&destination, total, piece_length).unwrap_or_else(|| {
        if aria2_path.exists() {
            if let Ok(control) = crate::aria2_control::read(&aria2_path) {
                if control.can_resume(total, piece_length) {
                    if let Some(recovered) =
                        PieceMap::from_bits(total, piece_length, control.bitfield)
                    {
                        return recovered;
                    }
                }
            }
        }
        PieceMap::new(total, piece_length)
    });
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
    let worker_abort = Arc::new(AtomicBool::new(false));
    let urls: Arc<Vec<String>> = Arc::new(mirrors);
    let headers = Arc::new(request_spec.headers.clone());
    let workers = request_spec.connections.clamp(1, 8);

    let mut handles = Vec::new();
    for index in 0..workers {
        let queue = queue.clone();
        let map = map.clone();
        let file = file.clone();
        let completed = completed.clone();
        let failure = failure.clone();
        let worker_abort = worker_abort.clone();
        let urls = urls.clone();
        let headers = headers.clone();
        let cancel = cancel.clone();
        handles.push(std::thread::spawn(move || {
            let mut buf = Vec::with_capacity(piece_length.min(4 * 1024 * 1024) as usize);
            // Workers start on different mirrors so the load spreads across CDN nodes.
            let mut cursor = index % urls.len().max(1);
            loop {
                if cancel.load(Ordering::Relaxed) || worker_abort.load(Ordering::Relaxed) {
                    return;
                }
                let run: Vec<(u64, (u64, u64))> = {
                    let mut pending = queue.lock().unwrap();
                    let Some(first) = pending.pop_front() else {
                        return;
                    };
                    // Shorter runs near the end keep every worker busy on the tail.
                    let limit = RUN_PIECES.min(pending.len() / workers + 1);
                    let mut pieces = vec![first];
                    while pieces.len() < limit
                        && pending.front() == Some(&(pieces[pieces.len() - 1] + 1))
                    {
                        pieces.push(pending.pop_front().unwrap());
                    }
                    let guard = map.lock().unwrap();
                    pieces
                        .into_iter()
                        .map(|piece| (piece, guard.range(piece)))
                        .collect()
                };
                let fetched = fetch_run(
                    &urls,
                    &headers,
                    &run,
                    &mut cursor,
                    &mut buf,
                    &cancel,
                    &worker_abort,
                    |piece, range, bytes| {
                        write_at(&file, range.0, bytes)?;
                        let mut guard = map.lock().unwrap();
                        guard.mark(piece);
                        completed.store(guard.completed_bytes(), Ordering::Relaxed);
                        Ok(())
                    },
                );
                match fetched {
                    Ok(()) => {}
                    Err(EngineError::Cancelled) => {
                        return;
                    }
                    Err(error) => {
                        let mut guard = failure.lock().expect("failure poisoned");
                        if guard.is_none() {
                            *guard = Some(error);
                        }
                        worker_abort.store(true, Ordering::Relaxed);
                        return;
                    }
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
        if cancel.load(Ordering::Relaxed) || worker_abort.load(Ordering::Relaxed) {
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

    file.sync_data().map_err(io_error)?;

    let length = std::fs::metadata(&destination).map_err(io_error)?.len();
    if length != total {
        return Err(EngineError::Corrupt("文件长度与远端不一致"));
    }
    let _ = std::fs::remove_file(sidecar::path_for(&destination));
    let _ = std::fs::remove_file(&aria2_path);
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
    let mut writer = std::io::BufWriter::with_capacity(512 * 1024, &mut file);
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
        writer.write_all(&buffer[..read]).map_err(io_error)?;
        written += read as u64;
        progress(written, total);
    }
    writer.flush().map_err(io_error)?;
    drop(writer);
    file.sync_data().map_err(io_error)?;
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
            Self::start_with(data, fail_first, 500, 0)
        }

        /// Answers the first `fail_first` requests with `fail_status`, then cuts
        /// the next `truncate_first` ranged bodies off halfway.
        fn start_with(
            data: Vec<u8>,
            fail_first: usize,
            fail_status: u16,
            truncate_first: usize,
        ) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            let stop = Arc::new(AtomicBool::new(false));
            let flag = stop.clone();
            let handle = std::thread::spawn(move || {
                let mut failures = 0usize;
                let mut truncated = 0usize;
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
                            format!("HTTP/1.1 {fail_status} Oops\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                                .as_bytes(),
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
                    let probing = matches!(range, Some((0, Some(0))));
                    if range.is_some() && !probing && truncated < truncate_first {
                        truncated += 1;
                        let _ = stream.write_all(&body[..body.len() / 2]);
                        continue;
                    }
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

    fn write_aria2_control(path: &Path, total: u64, piece_length: u32, bitfield: &[u8]) {
        let mut buf = Vec::new();
        buf.extend_from_slice(&1u16.to_be_bytes()); // version = 1
        buf.extend_from_slice(&0u32.to_be_bytes()); // extension = 0
        buf.extend_from_slice(&0u32.to_be_bytes()); // info hash len = 0
        buf.extend_from_slice(&piece_length.to_be_bytes());
        buf.extend_from_slice(&total.to_be_bytes());
        buf.extend_from_slice(&0u64.to_be_bytes()); // upload_length = 0
        buf.extend_from_slice(&(bitfield.len() as u32).to_be_bytes());
        buf.extend_from_slice(bitfield);
        buf.extend_from_slice(&0u32.to_be_bytes()); // num_in_flight = 0
        std::fs::write(path, buf).unwrap();
    }

    #[test]
    fn resumes_from_a_legacy_aria2_control_file() {
        let piece_length = 1024u32;
        let data = payload(4 * 1024); // 4 pieces
        let requested_ranges: Arc<Mutex<Vec<(usize, usize)>>> = Arc::new(Mutex::new(Vec::new()));
        let ranges_clone = requested_ranges.clone();

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let server_data = data.clone();
        let handle = std::thread::spawn(move || {
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
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("range: bytes=") {
                        let value = value.trim();
                        let (start, end) = value.split_once('-').unwrap_or((value, ""));
                        range = Some((
                            start.parse::<usize>().unwrap_or(0),
                            end.parse::<usize>().ok(),
                        ));
                    }
                }
                let total = server_data.len();
                let (start, end) = match range {
                    Some((start, Some(end))) => (start, end.min(total - 1)),
                    Some((start, None)) => (start, total - 1),
                    None => (0, total - 1),
                };
                if let Some((s, Some(e))) = range {
                    ranges_clone.lock().unwrap().push((s, e));
                }
                let body = &server_data[start..=end];
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
        let server = Server {
            port,
            stop,
            handle: Some(handle),
        };

        let directory = std::env::temp_dir().join(format!(
            "bewly-transfer-aria2-resume-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let destination = directory.join("video.m4s");
        let aria2_path = directory.join("video.m4s.aria2");
        let _ = std::fs::remove_file(&destination);
        let _ = std::fs::remove_file(&aria2_path);
        let _ = std::fs::remove_file(sidecar::path_for(&destination));

        let mut initial_file = vec![0u8; 4096];
        initial_file[0..1024].copy_from_slice(&data[0..1024]);
        initial_file[2048..3072].copy_from_slice(&data[2048..3072]);
        std::fs::write(&destination, &initial_file).unwrap();

        write_aria2_control(&aria2_path, 4096, piece_length, &[0xA0]);

        let urls = vec![server.url()];
        let result = download(
            Request {
                urls: &urls,
                destination: &destination,
                piece_length,
                connections: 2,
                headers: vec![],
            },
            Arc::new(AtomicBool::new(false)),
            |_, _| {},
        )
        .unwrap();

        assert_eq!(std::fs::read(&result).unwrap(), data);
        assert!(
            !aria2_path.exists(),
            ".aria2 control file should be removed on completion"
        );
        assert!(
            !sidecar::path_for(&destination).exists(),
            "sidecar file should be removed on completion"
        );

        let ranges = requested_ranges.lock().unwrap().clone();
        for (start, end) in ranges {
            if start == 0 && end == 0 {
                continue;
            }
            assert!(
                (start == 1024 && end == 2047) || (start == 3072 && end == 4095),
                "unexpected range requested: {start}-{end}, expected only missing pieces 1 and 3"
            );
        }
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

    #[test]
    fn resumes_a_run_after_the_connection_drops_mid_body() {
        let data = payload(8 * 1024);
        let server = Server::start_with(data.clone(), 0, 500, 3);
        let directory =
            std::env::temp_dir().join(format!("bewly-transfer-drop-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let destination = directory.join("video.m4s");
        let _ = std::fs::remove_file(&destination);
        let _ = std::fs::remove_file(sidecar::path_for(&destination));
        let urls = vec![server.url()];
        download(
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
        assert_eq!(std::fs::read(&destination).unwrap(), data);
    }

    #[test]
    fn an_expired_link_fails_without_waiting_out_the_backoff() {
        // The probe goes through, then every piece request is refused with 403.
        let probe_ok = Server::start_with(payload(4 * 1024), 0, 403, 0);
        let refusing = Server::start_with(payload(4 * 1024), usize::MAX, 403, 0);
        let (total, _) = probe(&[probe_ok.url()], &[]).unwrap();
        assert_eq!(total, 4 * 1024);
        let mut cursor = 0;
        let mut buf = Vec::new();
        let started = std::time::Instant::now();
        let error = fetch_run(
            &[refusing.url()],
            &[],
            &[(0, (0, 1023))],
            &mut cursor,
            &mut buf,
            &AtomicBool::new(false),
            &AtomicBool::new(false),
            |_, _, _| Ok(()),
        )
        .unwrap_err();
        assert!(matches!(error, EngineError::Http(_)));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn peer_nodes_are_tried_after_cdn_mirrors() {
        let urls = vec![
            "https://xy1x2x3x4xy.mcdn.bilivideo.cn:4483/upgcxcode/a.m4s".to_string(),
            "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/a.m4s".to_string(),
            "https://cn-gdfs-ct-01-01.bilivideo.com/upgcxcode/a.m4s".to_string(),
        ];
        let ordered = prefer_cdn_mirrors(&urls);
        assert_eq!(
            ordered,
            vec![urls[1].clone(), urls[2].clone(), urls[0].clone()]
        );
    }
}
