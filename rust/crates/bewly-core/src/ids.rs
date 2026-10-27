//! Bilibili video id parsing, ported from `native/core.mjs`.

pub const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

fn valid_bvid(value: &str) -> bool {
    value.len() == 12
        && value.starts_with("BV")
        && value[2..].bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn valid_av(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() > 2 && bytes[2] != b'0' && bytes[2..].iter().all(u8::is_ascii_digit)
}

pub fn video_id(value: &str) -> Result<String, String> {
    if valid_bvid(value) {
        return Ok(value.to_string());
    }
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("av") && valid_av(&lower) {
        return Ok(format!("av{}", &lower[2..]));
    }
    let Some(rest) = value.strip_prefix("https://") else {
        return Err("请使用 B 站普通视频的 BV 链接".into());
    };
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    let host = authority.split(':').next().unwrap_or(authority);
    if !["www.bilibili.com", "bilibili.com", "m.bilibili.com"].contains(&host) {
        return Err("请使用 B 站普通视频的 BV 链接".into());
    }
    let path = format!("/{path}");
    let path = path.split(['?', '#']).next().unwrap_or("");
    let Some(segment) = path.strip_prefix("/video/") else {
        return Err("当前版本支持普通视频及分 P，暂不支持直播或番剧".into());
    };
    let id = segment.split('/').next().unwrap_or("");
    if valid_bvid(id) {
        return Ok(id.to_string());
    }
    let lower = id.to_ascii_lowercase();
    if lower.starts_with("av") && valid_av(&lower) {
        return Ok(lower);
    }
    Err("当前版本支持普通视频及分 P，暂不支持直播或番剧".into())
}

/// Only `b23.tv` and `bili2233.*` short links are expanded by the service.
pub fn is_short_link(value: &str) -> bool {
    let Some(rest) = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
    else {
        return false;
    };
    let host = rest.split('/').next().unwrap_or("");
    let host = host.split(':').next().unwrap_or(host);
    matches!(host, "b23.tv" | "bili2233.cn" | "bili2233.com")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_bv_av_and_video_urls() {
        assert_eq!(video_id("BV17x411w7KC").unwrap(), "BV17x411w7KC");
        assert_eq!(video_id("av170001").unwrap(), "av170001");
        assert_eq!(
            video_id("https://www.bilibili.com/video/BV17x411w7KC/?p=2").unwrap(),
            "BV17x411w7KC"
        );
        assert_eq!(
            video_id("https://m.bilibili.com/video/av170001").unwrap(),
            "av170001"
        );
    }

    #[test]
    fn rejects_foreign_and_non_video_links() {
        assert_eq!(
            video_id("https://bilibili.com.evil.test/video/BV17x411w7KC").unwrap_err(),
            "请使用 B 站普通视频的 BV 链接"
        );
        assert_eq!(
            video_id("https://www.bilibili.com/bangumi/play/ep1").unwrap_err(),
            "当前版本支持普通视频及分 P，暂不支持直播或番剧"
        );
        assert!(video_id("http://www.bilibili.com/video/BV17x411w7KC").is_err());
    }

    #[test]
    fn recognises_short_links() {
        assert!(is_short_link("https://b23.tv/abc"));
        assert!(is_short_link("http://bili2233.cn/xyz"));
        assert!(!is_short_link(
            "https://www.bilibili.com/video/BV17x411w7KC"
        ));
    }
}
