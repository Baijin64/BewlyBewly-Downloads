//! WBI signing for `/x/player/wbi/playurl`.
//!
//! The mixin key is derived from the two images advertised by the nav endpoint;
//! parameters are sorted, stripped of `!'()*`, percent-encoded and hashed together
//! with that key to produce `w_rid`.

use md5::{Digest, Md5};

const MIXIN_TAB: [usize; 64] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
    28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
    54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/// `https://i0.hdslb.com/bfs/wbi/<key>.png` → `<key>`
pub fn key_from_url(url: &str) -> Option<String> {
    let file = url.rsplit('/').next()?;
    let stem = file.split('.').next()?;
    if stem.len() < 8 {
        return None;
    }
    Some(stem.to_string())
}

pub fn mixin_key(img_key: &str, sub_key: &str) -> String {
    let raw = format!("{img_key}{sub_key}");
    let bytes = raw.as_bytes();
    MIXIN_TAB
        .iter()
        .filter_map(|index| bytes.get(*index))
        .map(|byte| char::from(*byte))
        .take(32)
        .collect()
}

fn percent_encode(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                output.push(char::from(byte))
            }
            _ => output.push_str(&format!("%{byte:02X}")),
        }
    }
    output
}

/// Returns the signed query string without the leading `?`.
pub fn sign(params: &[(&str, String)], mixin: &str, timestamp: i64) -> String {
    let mut items: Vec<(String, String)> = params
        .iter()
        .map(|(key, value)| {
            let cleaned: String = value.chars().filter(|c| !"!'()*".contains(*c)).collect();
            ((*key).to_string(), cleaned)
        })
        .collect();
    items.push(("wts".into(), timestamp.to_string()));
    items.sort_by(|left, right| left.0.cmp(&right.0));
    let query = items
        .iter()
        .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    let mut hasher = Md5::new();
    hasher.update(query.as_bytes());
    hasher.update(mixin.as_bytes());
    let digest = hasher.finalize();
    format!("{query}&w_rid={digest:x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_keys_from_the_nav_urls() {
        assert_eq!(
            key_from_url("https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png")
                .as_deref(),
            Some("7cd084941338484aae1ad9425b84077c")
        );
        assert!(key_from_url("https://i0.hdslb.com/bfs/wbi/x.png").is_none());
    }

    #[test]
    fn mixin_key_is_deterministic_and_thirty_two_chars() {
        let mixed = mixin_key(
            "7cd084941338484aae1ad9425b84077c",
            "4932caff0ff746eab6f01bf08b70ac45",
        );
        assert_eq!(mixed.len(), 32);
        assert_eq!(
            mixed,
            mixin_key(
                "7cd084941338484aae1ad9425b84077c",
                "4932caff0ff746eab6f01bf08b70ac45"
            )
        );
    }

    #[test]
    fn signature_sorts_params_and_appends_w_rid() {
        let signed = sign(
            &[
                ("foo", "114".into()),
                ("bar", "514".into()),
                ("zab", "1919810".into()),
            ],
            "mixin",
            1700000000,
        );
        assert!(signed.starts_with("bar=514&foo=114&wts=1700000000&zab=1919810"));
        assert!(signed.contains("&w_rid="));
        // The signed payload must be stable for the same inputs.
        assert_eq!(
            signed,
            sign(
                &[
                    ("zab", "1919810".into()),
                    ("bar", "514".into()),
                    ("foo", "114".into())
                ],
                "mixin",
                1700000000
            )
        );
    }

    #[test]
    fn filters_forbidden_characters() {
        let signed = sign(&[("q", "a!'()*b".into())], "m", 1);
        assert!(signed.starts_with("q=ab&wts=1"));
    }
}
