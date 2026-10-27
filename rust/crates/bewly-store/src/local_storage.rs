//! Chromium Local Storage decoding.
//!
//! Keys are `_<origin>` + `0x00` + encoding byte + name; values carry the same
//! encoding byte. Encoding 0 is UTF-16LE, 1 is Latin-1, anything else is treated
//! as unreadable so credentials are never decoded by accident.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalStorageEntry {
    pub origin: String,
    pub name: String,
    pub value: String,
}

const PREFIXES: [&str; 2] = ["_app://", "_file://"];

pub fn decode_key(key: &[u8]) -> Option<(String, String)> {
    let separator = key.iter().position(|byte| *byte == 0)?;
    let origin = std::str::from_utf8(&key[..separator]).ok()?;
    if !PREFIXES.iter().any(|prefix| origin.starts_with(prefix)) {
        return None;
    }
    let rest = &key[separator + 1..];
    let (encoding, name) = rest.split_first()?;
    if *encoding != 0 && *encoding != 1 {
        return None;
    }
    Some((
        origin.to_string(),
        String::from_utf8_lossy(name).into_owned(),
    ))
}

pub fn decode_value(value: &[u8]) -> Option<String> {
    let (encoding, payload) = value.split_first()?;
    match encoding {
        0 => {
            if payload.len() % 2 != 0 {
                return None;
            }
            let units: Vec<u16> = payload
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            String::from_utf16(&units).ok()
        }
        1 => Some(payload.iter().map(|byte| char::from(*byte)).collect()),
        _ => None,
    }
}

pub fn decode_entry(key: &[u8], value: &[u8]) -> Option<LocalStorageEntry> {
    let (origin, name) = decode_key(key)?;
    let value = decode_value(value)?;
    Some(LocalStorageEntry {
        origin,
        name,
        value,
    })
}

/// Names the download migration is allowed to read. Everything else (including
/// session cookies) is enumerated but never decoded.
pub const WHITELIST: [&str; 6] = [
    "setting",
    "defaultDownPath",
    "renameRule",
    "folderRenameRule",
    "createFolder",
    "createFolderAddIndex",
];

pub fn is_whitelisted(name: &str) -> bool {
    WHITELIST.contains(&name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_utf16_and_latin1_values() {
        let utf16 = [0u8, b'h', 0, b'i', 0];
        assert_eq!(decode_value(&utf16).as_deref(), Some("hi"));
        assert_eq!(decode_value(&[1u8, b'4', b'2']).as_deref(), Some("42"));
        assert_eq!(decode_value(&[9u8, 1, 2]), None);
    }

    #[test]
    fn rejects_keys_outside_the_extension_origins() {
        let mut key = b"_https://example.test\x00\x01setting".to_vec();
        assert!(decode_key(&key).is_none());
        key = b"_app://.\x00\x09setting".to_vec();
        assert!(decode_key(&key).is_none());
        key = b"_app://.\x00\x01setting".to_vec();
        assert_eq!(
            decode_key(&key),
            Some(("_app://.".to_string(), "setting".to_string()))
        );
    }

    #[test]
    fn invalid_values_are_not_decoded() {
        let key = b"_app://.\x00\x01user";
        assert!(decode_entry(key, &[255, 255, 255]).is_none());
    }
}
