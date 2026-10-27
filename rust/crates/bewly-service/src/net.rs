//! Bilibili HTTP access used by `inspect` and `expandLink`.
//!
//! Only two endpoints are needed: the short-link redirect and the video view API.
//! Playback URLs come from the extension's `prepared` payload, so no WBI signing
//! or playurl call is required here.

use std::time::Duration;

use bewly_core::ids::{is_short_link, video_id, USER_AGENT};
use serde_json::{json, Value};

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .redirects(0)
        .timeout(Duration::from_secs(20))
        .build()
}

fn base() -> String {
    std::env::var("BEWLY_API_BASE").unwrap_or_else(|_| "https://api.bilibili.com".to_string())
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
    let endpoint = format!(
        "{}/x/web-interface/view?{query}",
        base().trim_end_matches('/')
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
    let mut request = agent()
        .get(&endpoint)
        .set("User-Agent", USER_AGENT)
        .set("Referer", "https://www.bilibili.com/");
    if !cookie.is_empty() {
        request = request.set("Cookie", cookie);
    }
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
    let query = crate::wbi::sign(
        &[
            ("bvid", bvid.to_string()),
            ("cid", cid.to_string()),
            ("qn", (if quality == 0 { 127 } else { quality }).to_string()),
            ("fnval", "4048".into()),
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
    let mut request = agent()
        .get(&endpoint)
        .set("User-Agent", USER_AGENT)
        .set("Referer", "https://www.bilibili.com/");
    if !cookie.is_empty() {
        request = request.set("Cookie", cookie);
    }
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
}
