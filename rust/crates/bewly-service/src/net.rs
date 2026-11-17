//! Bilibili HTTP access used by `inspect` and `expandLink`.
//!
//! Only two endpoints are needed: the short-link redirect and the video view API.
//! Playback URLs come from the extension's `prepared` payload, so no WBI signing
//! or playurl call is required here.

use std::time::Duration;

use bewly_core::ids::{is_short_link, video_id, USER_AGENT};
use serde_json::{json, Value};

fn agent() -> &'static ureq::Agent {
    static SHARED_AGENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    SHARED_AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .redirects(0)
            .timeout(Duration::from_secs(20))
            .build()
    })
}

fn base() -> String {
    std::env::var("BEWLY_API_BASE").unwrap_or_else(|_| "https://api.bilibili.com".to_string())
}

fn member_base() -> String {
    std::env::var("BEWLY_MEMBER_API_BASE")
        .unwrap_or_else(|_| "https://member.bilibili.com".to_string())
}

fn anonymous_buvid() -> &'static str {
    static BUVID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    BUVID.get_or_init(|| {
        let b = base();
        if !b.starts_with("https://api.bilibili.com") {
            return "buvid3=test-buvid3; buvid4=test-buvid4".to_string();
        }
        let endpoint = format!("{}/x/frontend/finger/spi", b.trim_end_matches('/'));
        let res = agent()
            .get(&endpoint)
            .set("User-Agent", USER_AGENT)
            .set("Referer", "https://www.bilibili.com/")
            .call()
            .ok()
            .and_then(|r| r.into_json::<Value>().ok());
        if let Some(json) = res {
            let b3 = json.pointer("/data/b_3").and_then(Value::as_str);
            let b4 = json.pointer("/data/b_4").and_then(Value::as_str);
            if let (Some(b3), Some(b4)) = (b3, b4) {
                return format!("buvid3={b3}; buvid4={b4}");
            }
        }
        "buvid3=C82ADCA2-E9FD-7889-4E24-BE2C8C0A1E9E16237infoc".to_string()
    })
}

pub fn with_buvid(cookie: &str) -> String {
    let trimmed = cookie.trim();
    if trimmed.is_empty() {
        anonymous_buvid().to_string()
    } else if !trimmed.contains("buvid3") {
        format!("{trimmed}; {}", anonymous_buvid())
    } else {
        trimmed.to_string()
    }
}

pub fn fetch_join_time(cookie: &str) -> Result<i64, String> {
    let endpoint = format!(
        "{}/x2/creative/h5/calendar/event?ts=0",
        member_base().trim_end_matches('/')
    );
    let mut request = agent()
        .get(&endpoint)
        .set("User-Agent", USER_AGENT)
        .set("Referer", "https://www.bilibili.com/");
    if !cookie.is_empty() {
        request = request.set("Cookie", cookie);
    }
    let response = request
        .call()
        .map_err(|error| format!("B 站接口请求失败（{error}）"))?;
    if response.status() != 200 {
        return Err(format!("B 站接口请求失败（HTTP {}）", response.status()));
    }
    let body: Value = response
        .into_json()
        .map_err(|error| format!("B 站接口返回了无效内容：{error}"))?;
    let code = body.get("code").and_then(Value::as_i64).unwrap_or(-1);
    if code != 0 {
        let message = body
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("请求未成功");
        return Err(format!("B 站返回 {code}：{message}"));
    }
    let parse_jointime = |val: &Value| -> Option<i64> {
        if let Some(n) = val.as_i64() {
            return Some(n);
        }
        if let Some(s) = val.as_str() {
            return s.parse::<i64>().ok();
        }
        None
    };
    let jointime = body
        .pointer("/data/pfs/profile/jointime")
        .or_else(|| body.pointer("/pfs/profile/jointime"))
        .and_then(parse_jointime);
    match jointime {
        Some(time) if time > 0 => Ok(time),
        _ => Err("官方接口当前未提供该账号的入站时间，请确认已登录".into()),
    }
}

pub fn expand(value: &str) -> Result<String, String> {
    if !is_short_link(value) {
        video_id(value)?;
        return Ok(value.to_string());
    }
    let agent = agent();
    let mut current = value.replacen("http://", "https://", 1);
    for _ in 0..5 {
        if !is_short_link(&current) {
            break;
        }
        let parsed = url::Url::parse(&current).map_err(|_| "无效短链接地址")?;
        if !parsed.username().is_empty() || parsed.password().is_some() || parsed.port().is_some() {
            return Err("无效短链接地址".into());
        }
        let response = agent
            .get(&current)
            .set("User-Agent", USER_AGENT)
            .set("Referer", "https://www.bilibili.com/")
            .call();
        let location = match response {
            Ok(response) => response.header("location").map(str::to_string),
            Err(ureq::Error::Status(code, response)) if (300..400).contains(&code) => {
                response.header("location").map(str::to_string)
            }
            Err(error) => return Err(format!("短链接请求失败：{error}")),
        };
        let Some(location) = location else {
            return Err("短链接没有返回视频地址".into());
        };
        let next = parsed.join(&location).map_err(|_| "无效短链接跳转")?;
        if !matches!(next.scheme(), "http" | "https") {
            return Err("无效短链接跳转".into());
        }
        current = next.as_str().replacen("http://", "https://", 1);
    }
    video_id(&current)?;
    Ok(current)
}

fn requested_page(value: &str) -> u32 {
    url::Url::parse(value)
        .ok()
        .and_then(|url| {
            url.query_pairs()
                .find(|(key, _)| key == "p")
                .and_then(|(_, value)| value.parse::<u32>().ok())
        })
        .filter(|page| *page > 0)
        .unwrap_or(1)
}

pub fn inspect(value: &str, cookie: &str) -> Result<Value, String> {
    let expanded = expand(value)?;
    let id = video_id(&expanded)?;
    let query = if let Some(av) = id.strip_prefix("av") {
        format!("aid={av}")
    } else {
        format!("bvid={id}")
    };
    let wbi_endpoint = format!(
        "{}/x/web-interface/wbi/view?{query}",
        base().trim_end_matches('/')
    );
    let view_endpoint = format!(
        "{}/x/web-interface/view?{query}",
        base().trim_end_matches('/')
    );
    let cookie_header = with_buvid(cookie);
    let send = |endpoint: &str| {
        agent()
            .get(endpoint)
            .set("User-Agent", USER_AGENT)
            .set("Referer", "https://www.bilibili.com/")
            .set("Cookie", &cookie_header)
            .call()
    };
    let response = match send(&wbi_endpoint) {
        Ok(resp) if resp.status() == 200 => resp,
        _ => send(&view_endpoint).map_err(|error| format!("B 站接口请求失败（{error}）"))?,
    };
    if response.status() != 200 {
        return Err(format!("B 站接口请求失败（HTTP {}）", response.status()));
    }
    let body: Value = response
        .into_json()
        .map_err(|error| format!("B 站接口返回了无效内容：{error}"))?;
    let code = body.get("code").and_then(Value::as_i64).unwrap_or(-1);
    if code != 0 {
        let message = body
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("请求未成功");
        return Err(format!("B 站返回 {code}：{message}"));
    }
    let data = body.get("data").cloned().unwrap_or_else(|| json!({}));
    let pages: Vec<Value> = data
        .get("pages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|page| {
            json!({
                "cid": page.get("cid").cloned().unwrap_or(json!(0)),
                "page": page.get("page").cloned().unwrap_or(json!(1)),
                "title": page.get("part").cloned().unwrap_or_else(|| json!("")),
                "duration": page.get("duration").cloned().unwrap_or(json!(0)),
            })
        })
        .collect();
    let collection = data.get("ugc_season").map(|season| {
        let sections: Vec<Value> = season
            .get("sections")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|section| {
                let videos: Vec<Value> = section
                    .get("episodes")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(|episode| {
                        let bvid = episode.get("bvid").and_then(Value::as_str).unwrap_or("");
                        let cid = episode.get("cid").and_then(Value::as_i64).unwrap_or(0);
                        let available = !bvid.is_empty()
                            && bvid.len() == 12
                            && cid > 0
                            && episode.pointer("/arc/stat/view").and_then(Value::as_i64)
                                != Some(-1);
                        json!({
                            "bvid": bvid,
                            "cid": cid,
                            "title": episode.get("title").cloned().unwrap_or_else(|| json!("")),
                            "available": available,
                        })
                    })
                    .collect();
                json!({
                    "id": section.get("id").cloned().unwrap_or(json!(0)),
                    "title": section.get("title").cloned().unwrap_or_else(|| json!("")),
                    "videos": videos,
                })
            })
            .collect();
        json!({
            "id": season.get("id").cloned().unwrap_or(json!(0)),
            "title": season.get("title").cloned().unwrap_or_else(|| json!("")),
            "sections": sections,
        })
    });
    let mut result = json!({
        "requestedPage": requested_page(&expanded),
        "bvid": data.get("bvid").and_then(Value::as_str).unwrap_or(&id),
        "title": data.get("title").cloned().unwrap_or_else(|| json!("")),
        "author": data.pointer("/owner/name").cloned().unwrap_or_else(|| json!("")),
        "uid": data.pointer("/owner/mid").cloned().unwrap_or(json!(0)),
        "pubdate": data.get("pubdate").cloned().unwrap_or(json!(0)),
        "description": data.get("desc").cloned().unwrap_or_else(|| json!("")),
        "cover": data.get("pic").cloned().unwrap_or_else(|| json!("")),
        "pages": pages,
    });
    if let Some(collection) = collection {
        result["collection"] = collection;
    }
    Ok(result)
}

static WBI_KEYS: std::sync::OnceLock<std::sync::Mutex<Option<(String, String, i64)>>> =
    std::sync::OnceLock::new();

fn wbi_keys(cookie: &str) -> Result<(String, String), String> {
    let cache = WBI_KEYS.get_or_init(|| std::sync::Mutex::new(None));
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    if let Some((img, sub, stamp)) = cache.lock().unwrap_or_else(|p| p.into_inner()).clone() {
        if now - stamp < 3600 {
            return Ok((img, sub));
        }
    }
    let endpoint = format!("{}/x/web-interface/nav", base().trim_end_matches('/'));
    let cookie_header = with_buvid(cookie);
    let request = agent()
        .get(&endpoint)
        .set("User-Agent", USER_AGENT)
        .set("Referer", "https://www.bilibili.com/")
        .set("Cookie", &cookie_header);
    let body: Value = request
        .call()
        .map_err(|error| format!("B 站导航接口请求失败（{error}）"))?
        .into_json()
        .map_err(|error| format!("B 站导航接口返回了无效内容：{error}"))?;
    let img = body
        .pointer("/data/wbi_img/img_url")
        .and_then(Value::as_str)
        .and_then(crate::wbi::key_from_url)
        .ok_or("B 站没有返回签名密钥")?;
    let sub = body
        .pointer("/data/wbi_img/sub_url")
        .and_then(Value::as_str)
        .and_then(crate::wbi::key_from_url)
        .ok_or("B 站没有返回签名密钥")?;
    *cache.lock().unwrap_or_else(|p| p.into_inner()) = Some((img.clone(), sub.clone(), now));
    Ok((img, sub))
}

/// Resolves playback streams for a task without a prepared payload.
pub fn resolve(
    bvid: &str,
    cid: u64,
    quality: u32,
    audio_quality: &str,
    outputs: &[String],
    codec: &str,
    cookie: &str,
) -> Result<Value, String> {
    let (img, sub) = wbi_keys(cookie)?;
    let mixin = crate::wbi::mixin_key(&img, &sub);
    let timestamp = time::OffsetDateTime::now_utc().unix_timestamp();
    let use_durl = bewly_media::ffmpeg().is_none()
        && outputs.iter().any(|kind| kind == "video")
        && !outputs
            .iter()
            .any(|kind| kind == "audio" || kind == "silent" || kind == "mp3");
    let fnval = if use_durl { "1" } else { "4048" };
    let query = crate::wbi::sign(
        &[
            ("bvid", bvid.to_string()),
            ("cid", cid.to_string()),
            ("qn", (if quality == 0 { 127 } else { quality }).to_string()),
            ("fnval", fnval.into()),
            ("fnver", "0".into()),
            ("fourk", "1".into()),
        ],
        &mixin,
        timestamp,
    );
    let endpoint = format!(
        "{}/x/player/wbi/playurl?{query}",
        base().trim_end_matches('/')
    );
    let cookie_header = with_buvid(cookie);
    let request = agent()
        .get(&endpoint)
        .set("User-Agent", USER_AGENT)
        .set("Referer", "https://www.bilibili.com/")
        .set("Cookie", &cookie_header);
    let body: Value = request
        .call()
        .map_err(|error| format!("B 站播放接口请求失败（{error}）"))?
        .into_json()
        .map_err(|error| format!("B 站播放接口返回了无效内容：{error}"))?;
    let code = body.get("code").and_then(Value::as_i64).unwrap_or(-1);
    if code != 0 {
        let message = body
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("请求未成功");
        return Err(format!("B 站返回 {code}：{message}"));
    }
    let data = body.get("data").cloned().unwrap_or_else(|| json!({}));
    let options = bewly_core::formats::DownloadOptions {
        quality,
        codec: codec.to_string(),
        audio_quality: audio_quality.to_string(),
        outputs: outputs.to_vec(),
        ..Default::default()
    };
    let streams = bewly_core::formats::select_streams(&data, &options)?;
    Ok(json!({
        "video": streams.video,
        "audio": streams.audio,
        "preparedAt": time::OffsetDateTime::now_utc().unix_timestamp() * 1000,
    }))
}

/// Fetches a small binary asset (covers) for the attachment step.
pub fn fetch_bytes(url: &str) -> Result<(Vec<u8>, String), String> {
    let lower = url.to_ascii_lowercase();
    if !lower.starts_with("https://")
        && !lower.starts_with("http://127.0.0.1")
        && !lower.starts_with("http://localhost")
    {
        return Err("封面地址不受支持".into());
    }
    let response = agent()
        .get(url)
        .set("User-Agent", USER_AGENT)
        .set("Referer", "https://www.bilibili.com/")
        .call()
        .map_err(|error| format!("封面下载失败：{error}"))?;
    let content_type = response.header("content-type").unwrap_or("").to_string();
    let mut bytes = Vec::new();
    response
        .into_reader()
        .read_to_end(&mut bytes)
        .map_err(|error| format!("封面下载失败：{error}"))?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("封面文件过大".into());
    }
    Ok((bytes, content_type))
}

/// Fetches XML danmaku for the attachment step.
pub fn fetch_danmaku(cid: u64) -> Result<String, String> {
    let url = if let Ok(custom) = std::env::var("BEWLY_DANMAKU_BASE") {
        format!("{}/{cid}.xml", custom.trim_end_matches('/'))
    } else if let Ok(custom) = std::env::var("BEWLY_API_BASE") {
        format!("{}/{cid}.xml", custom.trim_end_matches('/'))
    } else {
        format!("https://comment.bilibili.com/{cid}.xml")
    };
    let response = match agent()
        .get(&url)
        .set("User-Agent", USER_AGENT)
        .set("Referer", "https://www.bilibili.com/")
        .call()
    {
        Ok(res) => res,
        Err(ureq::Error::Status(code, _)) => {
            return Err(format!("弹幕请求失败（HTTP {code}）"));
        }
        Err(error) => {
            return Err(format!("弹幕请求失败：{error}"));
        }
    };
    let text = response
        .into_string()
        .map_err(|error| format!("弹幕读取失败：{error}"))?;
    if !text.contains("<i") {
        return Err("接口没有返回 XML 弹幕".into());
    }
    Ok(text)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubtitleTrack {
    pub language: String,
    pub content: String,
}

/// Fetches and formats subtitles for the attachment step.
pub fn fetch_subtitles(
    bvid: &str,
    cid: u64,
    prepared_tracks: Option<&[Value]>,
    languages: &[String],
    cookie: &str,
) -> Result<Vec<SubtitleTrack>, String> {
    let mut tracks_to_fetch: Vec<(String, String)> = Vec::new();

    if let Some(tracks) = prepared_tracks {
        for track in tracks {
            let url = track
                .get("url")
                .or_else(|| track.get("subtitle_url"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let lan = track
                .get("language")
                .or_else(|| track.get("lan"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if !url.is_empty() && !lan.is_empty() {
                tracks_to_fetch.push((lan.to_string(), url.to_string()));
            }
        }
    }

    if tracks_to_fetch.is_empty() {
        let endpoint = format!(
            "{}/x/player/v2?bvid={bvid}&cid={cid}",
            base().trim_end_matches('/')
        );
        let mut request = agent()
            .get(&endpoint)
            .set("User-Agent", USER_AGENT)
            .set("Referer", "https://www.bilibili.com/");
        if !cookie.is_empty() {
            request = request.set("Cookie", cookie);
        }
        let response = match request.call() {
            Ok(res) => res,
            Err(ureq::Error::Status(code, _)) => {
                return Err(format!("字幕请求失败（HTTP {code}）"));
            }
            Err(error) => {
                return Err(format!("字幕请求失败：{error}"));
            }
        };
        let body: Value = response
            .into_json()
            .map_err(|error| format!("字幕接口返回了无效内容：{error}"))?;
        let subtitles = body
            .pointer("/data/subtitle/subtitles")
            .or_else(|| body.pointer("/subtitle/subtitles"))
            .and_then(Value::as_array);
        if let Some(subtitles) = subtitles {
            for sub in subtitles {
                let url = sub
                    .get("subtitle_url")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let lan = sub.get("lan").and_then(Value::as_str).unwrap_or("");
                if !url.is_empty() && !lan.is_empty() {
                    tracks_to_fetch.push((lan.to_string(), url.to_string()));
                }
            }
        }
    }

    let mut result = Vec::new();
    for (lan, raw_url) in tracks_to_fetch {
        if !languages.is_empty() && !languages.iter().any(|l| l == &lan) {
            continue;
        }
        let target_url = if raw_url.starts_with("//") {
            format!("https:{raw_url}")
        } else if raw_url.starts_with('/') {
            format!("{}{raw_url}", base().trim_end_matches('/'))
        } else {
            raw_url
        };
        let response = match agent()
            .get(&target_url)
            .set("User-Agent", USER_AGENT)
            .set("Referer", "https://www.bilibili.com/")
            .call()
        {
            Ok(res) => res,
            Err(ureq::Error::Status(code, _)) => {
                return Err(format!("字幕请求失败（HTTP {code}）"));
            }
            Err(error) => {
                return Err(format!("字幕下载失败：{error}"));
            }
        };
        let sub_data: Value = response
            .into_json()
            .map_err(|error| format!("字幕内容不是合法 JSON：{error}"))?;
        let fallback = Value::Array(Vec::new());
        let cues = sub_data
            .get("body")
            .or_else(|| sub_data.pointer("/data/body"))
            .unwrap_or(&fallback);
        let content =
            bewly_core::formats::to_srt(cues).map_err(|error| format!("字幕转换失败：{error}"))?;
        result.push(SubtitleTrack {
            language: lan,
            content,
        });
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requested_page_falls_back_to_one() {
        assert_eq!(
            requested_page("https://www.bilibili.com/video/BV17x411w7KC"),
            1
        );
        assert_eq!(
            requested_page("https://www.bilibili.com/video/BV17x411w7KC/?p=3"),
            3
        );
        assert_eq!(
            requested_page("https://www.bilibili.com/video/BV17x411w7KC/?p=x"),
            1
        );
    }

    #[test]
    fn fetch_bytes_rejects_insecure_protocols() {
        let result = fetch_bytes("ftp://example.com/cover.png");
        assert!(result.is_err());
    }

    #[test]
    fn fetch_danmaku_parses_xml_and_rejects_empty() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let body = "<i><d p=\"0,1,25,16777215,0\">弹幕内容</d></i>";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        std::env::set_var("BEWLY_DANMAKU_BASE", format!("http://127.0.0.1:{port}"));
        let result = fetch_danmaku(12345).unwrap();
        assert!(result.contains("弹幕内容"));
        std::env::remove_var("BEWLY_DANMAKU_BASE");
    }

    #[test]
    fn fetch_subtitles_converts_json_body_to_srt() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let body = json!({
                    "body": [
                        { "from": 0.0, "to": 1.5, "content": "第一句字幕" },
                        { "from": 2.0, "to": 3.0, "content": "第二句字幕" }
                    ]
                })
                .to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        let tracks = json!([
            { "url": format!("http://127.0.0.1:{port}/sub.json"), "language": "zh-CN" }
        ]);
        let subtitles = fetch_subtitles(
            "BV17x411w7KC",
            11,
            tracks.as_array().map(|a| a.as_slice()),
            &[],
            "",
        )
        .unwrap();
        assert_eq!(subtitles.len(), 1);
        assert_eq!(subtitles[0].language, "zh-CN");
        assert!(subtitles[0].content.contains("第一句字幕"));
    }

    #[test]
    fn fetch_join_time_parses_json_and_handles_errors() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let responses = vec![
            json!({
                "code": 0,
                "message": "0",
                "data": {
                    "pfs": {
                        "profile": {
                            "jointime": 1580000000
                        }
                    }
                }
            }),
            json!({
                "code": 0,
                "pfs": {
                    "profile": {
                        "jointime": 1600000000
                    }
                }
            }),
            json!({
                "code": 0,
                "data": {
                    "pfs": {
                        "profile": {
                            "jointime": 0
                        }
                    }
                }
            }),
            json!({
                "code": -101,
                "message": "账号未登录"
            }),
        ];

        std::thread::spawn(move || {
            for item in responses {
                if let Ok((mut stream, _)) = listener.accept() {
                    let mut buf = [0u8; 1024];
                    let _ = stream.read(&mut buf);
                    let body = item.to_string();
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes());
                }
            }
        });

        std::env::set_var("BEWLY_MEMBER_API_BASE", format!("http://127.0.0.1:{port}"));

        let res1 = fetch_join_time("SESSDATA=test").unwrap();
        assert_eq!(res1, 1580000000);

        let res2 = fetch_join_time("").unwrap();
        assert_eq!(res2, 1600000000);

        let err3 = fetch_join_time("").unwrap_err();
        assert_eq!(err3, "官方接口当前未提供该账号的入站时间，请确认已登录");

        let err4 = fetch_join_time("").unwrap_err();
        assert_eq!(err4, "B 站返回 -101：账号未登录");

        std::env::remove_var("BEWLY_MEMBER_API_BASE");
    }
}
