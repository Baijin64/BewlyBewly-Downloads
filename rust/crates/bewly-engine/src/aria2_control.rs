//! Reader for aria2's binary control file (`*.aria2`).
//!
//! Layout, big-endian in version 1 (the only version aria2 has written since 1.4.1):
//!
//! ```text
//! VER(2) EXT(4) INFO_HASH_LEN(4) INFO_HASH(n)
//! PIECE_LENGTH(4) TOTAL_LENGTH(8) UPLOAD_LENGTH(8)
//! BITFIELD_LEN(4) BITFIELD(n)
//! NUM_IN_FLIGHT(4) { INDEX(4) LENGTH(4) PIECE_BITFIELD_LEN(4) PIECE_BITFIELD(n) } *
//! ```
//!
//! The main bitfield marks *complete* pieces only. In-flight pieces carry their own
//! 16 KiB chunk bitfield and are deliberately treated as incomplete: resuming them
//! chunk-by-chunk would be the only way to corrupt a file silently.

use std::path::Path;

use thiserror::Error;

const MAX_PIECES: u64 = 1 << 22;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ControlError {
    #[error("控制文件为空或已截断")]
    Truncated,
    #[error("不支持的 aria2 控制文件版本：{0}")]
    UnsupportedVersion(u16),
    #[error("控制文件字段不一致：{0}")]
    Inconsistent(&'static str),
    #[error("控制文件无法读取：{0}")]
    Io(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InFlightPiece {
    pub index: u32,
    pub length: u32,
    pub bitfield: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlFile {
    pub version: u16,
    pub piece_length: u32,
    pub total_length: u64,
    pub upload_length: u64,
    pub bitfield: Vec<u8>,
    pub pieces: u64,
    pub in_flight: Vec<InFlightPiece>,
}

impl ControlFile {
    /// Bytes proven complete by the main bitfield, i.e. safe to keep on resume.
    pub fn completed_bytes(&self) -> u64 {
        let mut completed = 0u64;
        for index in 0..self.pieces {
            if !self.is_complete(index) {
                continue;
            }
            let start = index * u64::from(self.piece_length);
            let remain = self.total_length.saturating_sub(start);
            completed += remain.min(u64::from(self.piece_length));
        }
        completed
    }

    pub fn is_complete(&self, piece: u64) -> bool {
        let byte = (piece / 8) as usize;
        let bit = 7 - (piece % 8) as u32;
        self.bitfield
            .get(byte)
            .map(|value| value & (1 << bit) != 0)
            .unwrap_or(false)
    }

    pub fn complete_pieces(&self) -> u64 {
        (0..self.pieces)
            .filter(|index| self.is_complete(*index))
            .count() as u64
    }

    /// A resume is only trustworthy when the remote object still has the same size
    /// and the control file uses the piece size the engine is planning to use.
    pub fn can_resume(&self, content_length: u64, piece_length: u32) -> bool {
        self.total_length == content_length
            && self.piece_length == piece_length
            && piece_length > 0
            && self.pieces > 0
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], ControlError> {
        let end = self
            .position
            .checked_add(count)
            .ok_or(ControlError::Truncated)?;
        if end > self.bytes.len() {
            return Err(ControlError::Truncated);
        }
        let slice = &self.bytes[self.position..end];
        self.position = end;
        Ok(slice)
    }

    fn u16(&mut self) -> Result<u16, ControlError> {
        let bytes = self.take(2)?;
        Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
    }

    fn u32(&mut self) -> Result<u32, ControlError> {
        let bytes = self.take(4)?;
        Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn u64(&mut self) -> Result<u64, ControlError> {
        let bytes = self.take(8)?;
        let mut value = [0u8; 8];
        value.copy_from_slice(bytes);
        Ok(u64::from_be_bytes(value))
    }
}

pub fn parse(bytes: &[u8]) -> Result<ControlFile, ControlError> {
    let mut reader = Reader::new(bytes);
    let version = reader.u16()?;
    if version != 1 {
        return Err(ControlError::UnsupportedVersion(version));
    }
    let _extension = reader.u32()?;
    let info_hash_length = reader.u32()? as usize;
    if info_hash_length > 0 {
        reader.take(info_hash_length)?;
    }
    let piece_length = reader.u32()?;
    let total_length = reader.u64()?;
    let upload_length = reader.u64()?;
    if piece_length == 0 {
        return Err(ControlError::Inconsistent("piece length is zero"));
    }
    let pieces = total_length.div_ceil(u64::from(piece_length));
    if pieces > MAX_PIECES {
        return Err(ControlError::Inconsistent("piece count out of range"));
    }
    let bitfield_length = reader.u32()? as usize;
    let expected = pieces.div_ceil(8) as usize;
    if bitfield_length != expected {
        return Err(ControlError::Inconsistent("bitfield length mismatch"));
    }
    let bitfield = reader.take(bitfield_length)?.to_vec();

    let mut in_flight = Vec::new();
    if reader.position < bytes.len() {
        let count = reader.u32()? as usize;
        if count > pieces as usize {
            return Err(ControlError::Inconsistent("in-flight count out of range"));
        }
        for _ in 0..count {
            let index = reader.u32()?;
            let length = reader.u32()?;
            let bitfield_length = reader.u32()? as usize;
            let bitfield = reader.take(bitfield_length)?.to_vec();
            in_flight.push(InFlightPiece {
                index,
                length,
                bitfield,
            });
        }
    }

    Ok(ControlFile {
        version,
        piece_length,
        total_length,
        upload_length,
        bitfield,
        pieces,
        in_flight,
    })
}

pub fn read(path: &Path) -> Result<ControlFile, ControlError> {
    let bytes = std::fs::read(path).map_err(|error| ControlError::Io(error.to_string()))?;
    parse(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL_FIXTURE: &[u8] = include_bytes!("../tests/fixtures/aria2-1.36-http.aria2");

    fn synthetic(piece_length: u32, total: u64, complete: &[u64]) -> Vec<u8> {
        let pieces = total.div_ceil(u64::from(piece_length));
        let mut bitfield = vec![0u8; pieces.div_ceil(8) as usize];
        for piece in complete {
            bitfield[(piece / 8) as usize] |= 1 << (7 - (piece % 8));
        }
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&1u16.to_be_bytes());
        bytes.extend_from_slice(&0u32.to_be_bytes());
        bytes.extend_from_slice(&0u32.to_be_bytes());
        bytes.extend_from_slice(&piece_length.to_be_bytes());
        bytes.extend_from_slice(&total.to_be_bytes());
        bytes.extend_from_slice(&0u64.to_be_bytes());
        bytes.extend_from_slice(&(bitfield.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&bitfield);
        bytes.extend_from_slice(&0u32.to_be_bytes());
        bytes
    }

    #[test]
    fn parses_a_real_aria2_1_36_control_file() {
        let control = parse(REAL_FIXTURE).expect("fixture must parse");
        assert_eq!(control.version, 1);
        assert_eq!(control.piece_length, 1024 * 1024);
        assert_eq!(control.total_length, 8 * 1024 * 1024);
        assert_eq!(control.pieces, 8);
        assert_eq!(control.complete_pieces(), 0);
        assert_eq!(control.completed_bytes(), 0);
        assert_eq!(control.in_flight.len(), 1);
        let piece = &control.in_flight[0];
        assert_eq!(piece.index, 0);
        assert_eq!(piece.length, 1024 * 1024);
        // 0xFFC0: ten 16 KiB chunks were in flight when the file was written.
        assert_eq!(piece.bitfield, vec![0xFF, 0xC0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn counts_only_complete_pieces_and_truncates_the_last_one() {
        let bytes = synthetic(1024, 2500, &[0, 1, 2]);
        let control = parse(&bytes).unwrap();
        assert_eq!(control.pieces, 3);
        assert!(control.is_complete(0) && control.is_complete(1) && control.is_complete(2));
        assert_eq!(control.completed_bytes(), 2500);
        assert_eq!(control.complete_pieces(), 3);
    }

    #[test]
    fn partial_bitfield_reports_the_expected_offset() {
        let control = parse(&synthetic(1024, 10 * 1024, &[0, 1, 2, 3, 4])).unwrap();
        assert_eq!(control.completed_bytes(), 5 * 1024);
        assert!(control.can_resume(10 * 1024, 1024));
        assert!(!control.can_resume(10 * 1024 + 1, 1024));
        assert!(!control.can_resume(10 * 1024, 2048));
    }

    #[test]
    fn rejects_other_versions() {
        let mut bytes = synthetic(1024, 1024, &[]);
        bytes[0] = 0;
        bytes[1] = 0;
        assert_eq!(
            parse(&bytes).unwrap_err(),
            ControlError::UnsupportedVersion(0)
        );
    }

    #[test]
    fn rejects_truncated_and_inconsistent_files() {
        assert_eq!(
            parse(&REAL_FIXTURE[..10]).unwrap_err(),
            ControlError::Truncated
        );
        let mut bytes = synthetic(1024, 1024, &[]);
        bytes.truncate(bytes.len() - 2);
        assert!(parse(&bytes).is_err());
        // piece length zero
        let mut zero = synthetic(1024, 1024, &[]);
        zero[10..14].copy_from_slice(&0u32.to_be_bytes());
        assert_eq!(
            parse(&zero).unwrap_err(),
            ControlError::Inconsistent("piece length is zero")
        );
    }
}
