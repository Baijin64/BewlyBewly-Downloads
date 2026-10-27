//! `uint32LE length + UTF-8 JSON` framing.
//!
//! Chrome kills the host when it observes an invalid length, so the reader is
//! strict: zero-length frames and anything above 2 MiB are rejected instead of
//! being clamped, and a partial header at EOF surfaces as an error.

use std::io::{self, Read, Write};

pub const MAX_FRAME: usize = 2 * 1024 * 1024;

#[derive(Debug)]
pub enum FrameError {
    Io(io::Error),
    /// The peer closed the pipe between frames: a clean end of input.
    Eof,
    Invalid(&'static str),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::Io(error) => write!(formatter, "读取原生消息失败：{error}"),
            FrameError::Eof => write!(formatter, "原生消息流已结束"),
            FrameError::Invalid(reason) => write!(formatter, "原生消息格式无效：{reason}"),
        }
    }
}

impl std::error::Error for FrameError {}

impl From<io::Error> for FrameError {
    fn from(error: io::Error) -> Self {
        FrameError::Io(error)
    }
}

fn read_exact(reader: &mut impl Read, buffer: &mut [u8]) -> Result<usize, FrameError> {
    let mut filled = 0usize;
    while filled < buffer.len() {
        match reader.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(count) => filled += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(FrameError::Io(error)),
        }
    }
    Ok(filled)
}

/// Reads one frame. `Ok(None)` means the stream ended on a frame boundary.
pub fn read_frame(reader: &mut impl Read) -> Result<Option<Vec<u8>>, FrameError> {
    let mut header = [0u8; 4];
    let filled = read_exact(reader, &mut header)?;
    if filled == 0 {
        return Ok(None);
    }
    if filled < header.len() {
        return Err(FrameError::Invalid("长度前缀不完整"));
    }
    let length = u32::from_le_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err(FrameError::Invalid("长度超出允许范围"));
    }
    let mut body = vec![0u8; length];
    let filled = read_exact(reader, &mut body)?;
    if filled < length {
        return Err(FrameError::Invalid("消息体不完整"));
    }
    Ok(Some(body))
}

pub fn write_frame(writer: &mut impl Write, body: &[u8]) -> Result<(), FrameError> {
    if body.is_empty() || body.len() > MAX_FRAME {
        return Err(FrameError::Invalid("回复长度超出允许范围"));
    }
    let mut header = [0u8; 4];
    header.copy_from_slice(&(body.len() as u32).to_le_bytes());
    writer.write_all(&header)?;
    writer.write_all(body)?;
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn round_trips_a_frame() {
        let payload = br#"{"method":"health"}"#;
        let mut bytes = Vec::new();
        write_frame(&mut bytes, payload).unwrap();
        assert_eq!(&bytes[..4], &(payload.len() as u32).to_le_bytes());
        let body = read_frame(&mut Cursor::new(bytes)).unwrap().unwrap();
        assert_eq!(body, payload);
    }

    #[test]
    fn clean_eof_returns_none() {
        assert!(read_frame(&mut Cursor::new(Vec::new())).unwrap().is_none());
    }

    #[test]
    fn truncated_header_is_rejected() {
        let error = read_frame(&mut Cursor::new(vec![1u8, 0])).unwrap_err();
        assert!(matches!(error, FrameError::Invalid("长度前缀不完整")));
    }

    #[test]
    fn zero_and_oversized_lengths_are_rejected() {
        let zero = read_frame(&mut Cursor::new(vec![0u8, 0, 0, 0])).unwrap_err();
        assert!(matches!(zero, FrameError::Invalid("长度超出允许范围")));
        let oversized = (MAX_FRAME as u32 + 1).to_le_bytes().to_vec();
        let error = read_frame(&mut Cursor::new(oversized)).unwrap_err();
        assert!(matches!(error, FrameError::Invalid("长度超出允许范围")));
    }

    #[test]
    fn truncated_body_is_rejected() {
        let mut bytes = 10u32.to_le_bytes().to_vec();
        bytes.extend_from_slice(b"short");
        let error = read_frame(&mut Cursor::new(bytes)).unwrap_err();
        assert!(matches!(error, FrameError::Invalid("消息体不完整")));
    }

    #[test]
    fn byte_by_byte_delivery_is_accepted() {
        struct Trickle {
            bytes: Vec<u8>,
            position: usize,
        }
        impl Read for Trickle {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                if self.position >= self.bytes.len() || buffer.is_empty() {
                    return Ok(0);
                }
                buffer[0] = self.bytes[self.position];
                self.position += 1;
                Ok(1)
            }
        }
        let mut bytes = Vec::new();
        write_frame(&mut bytes, b"payload").unwrap();
        let mut trickle = Trickle { bytes, position: 0 };
        assert_eq!(read_frame(&mut trickle).unwrap().unwrap(), b"payload");
    }
}
