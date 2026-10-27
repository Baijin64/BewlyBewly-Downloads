//! Resume sidecar (`<name>.bewly.json`).
//!
//! The aria2 control file is read once for legacy tasks; new downloads keep their
//! own state so the engine never has to guess how much of a file is trustworthy.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::plan::PieceMap;

pub const SCHEMA: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Sidecar {
    pub schema: u32,
    pub source: String,
    pub url: String,
    pub total: u64,
    pub piece_length: u32,
    pub pieces: u64,
    /// Hex encoded bitmap, MSB first, identical to the in-memory layout.
    pub bitmap: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub etag: String,
    pub created_at: String,
    pub updated_at: String,
}

pub fn path_for(destination: &Path) -> PathBuf {
    let mut name = destination
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());
    name.push_str(".bewly.json");
    destination.with_file_name(name)
}

fn encode(bits: &[u8]) -> String {
    bits.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode(value: &str) -> Option<Vec<u8>> {
    if value.len() % 2 != 0 {
        return None;
    }
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).ok())
        .collect()
}

pub fn load(destination: &Path, total: u64, piece_length: u32) -> Option<PieceMap> {
    let text = std::fs::read_to_string(path_for(destination)).ok()?;
    let sidecar: Sidecar = serde_json::from_str(&text).ok()?;
    if sidecar.schema != SCHEMA || sidecar.total != total || sidecar.piece_length != piece_length {
        return None;
    }
    let bits = decode(&sidecar.bitmap)?;
    PieceMap::from_bits(total, piece_length, bits)
}

pub fn save(
    destination: &Path,
    map: &PieceMap,
    url: &str,
    etag: &str,
    created_at: &str,
) -> std::io::Result<()> {
    let sidecar = Sidecar {
        schema: SCHEMA,
        source: "rust".into(),
        url: url.to_string(),
        total: map.total(),
        piece_length: map.piece_length(),
        pieces: map.pieces(),
        bitmap: encode(map.bits()),
        etag: etag.to_string(),
        created_at: created_at.to_string(),
        updated_at: time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default(),
    };
    let payload = serde_json::to_vec(&sidecar)?;
    let target = path_for(destination);
    let temporary = target.with_extension("json.tmp");
    std::fs::write(&temporary, &payload)?;
    std::fs::rename(&temporary, &target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_bitmap() {
        let directory = std::env::temp_dir().join(format!("bewly-sidecar-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let destination = directory.join("video.m4s");
        let mut map = PieceMap::new(4096, 1024);
        map.mark(0);
        map.mark(2);
        save(
            &destination,
            &map,
            "https://example.test/v.m4s",
            "abc",
            "now",
        )
        .unwrap();
        let loaded = load(&destination, 4096, 1024).expect("sidecar must load");
        assert_eq!(loaded.bits(), map.bits());
        assert_eq!(loaded.completed_bytes(), 2048);
        assert!(load(&destination, 4097, 1024).is_none());
    }
}
