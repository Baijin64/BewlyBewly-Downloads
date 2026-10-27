//! Piece bookkeeping for the resumable downloader.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PieceMap {
    total: u64,
    piece_length: u32,
    bits: Vec<u8>,
}

impl PieceMap {
    pub fn new(total: u64, piece_length: u32) -> Self {
        let pieces = total.div_ceil(u64::from(piece_length.max(1))) as usize;
        Self {
            total,
            piece_length: piece_length.max(1),
            bits: vec![0u8; pieces.div_ceil(8)],
        }
    }

    pub fn from_bits(total: u64, piece_length: u32, bits: Vec<u8>) -> Option<Self> {
        let map = Self::new(total, piece_length);
        if map.bits.len() != bits.len() {
            return None;
        }
        Some(Self { bits, ..map })
    }

    pub fn total(&self) -> u64 {
        self.total
    }

    pub fn piece_length(&self) -> u32 {
        self.piece_length
    }

    pub fn pieces(&self) -> u64 {
        self.total.div_ceil(u64::from(self.piece_length))
    }

    pub fn bits(&self) -> &[u8] {
        &self.bits
    }

    pub fn is_done(&self, piece: u64) -> bool {
        let byte = (piece / 8) as usize;
        self.bits
            .get(byte)
            .map(|value| value & (1 << (7 - (piece % 8))) != 0)
            .unwrap_or(false)
    }

    pub fn mark(&mut self, piece: u64) {
        let byte = (piece / 8) as usize;
        if let Some(value) = self.bits.get_mut(byte) {
            *value |= 1 << (7 - (piece % 8));
        }
    }

    pub fn completed_bytes(&self) -> u64 {
        (0..self.pieces())
            .filter(|piece| self.is_done(*piece))
            .map(|piece| {
                let start = piece * u64::from(self.piece_length);
                self.total
                    .saturating_sub(start)
                    .min(u64::from(self.piece_length))
            })
            .sum()
    }

    pub fn missing(&self) -> Vec<u64> {
        (0..self.pieces())
            .filter(|piece| !self.is_done(*piece))
            .collect()
    }

    pub fn is_complete(&self) -> bool {
        self.completed_bytes() == self.total
    }

    /// Byte range of a piece, clamped to the file size.
    pub fn range(&self, piece: u64) -> (u64, u64) {
        let start = piece * u64::from(self.piece_length);
        let end = (start + u64::from(self.piece_length) - 1).min(self.total.saturating_sub(1));
        (start, end)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_pieces_and_clamps_the_last_one() {
        let mut map = PieceMap::new(2500, 1024);
        assert_eq!(map.pieces(), 3);
        assert_eq!(map.range(2), (2048, 2499));
        assert_eq!(map.completed_bytes(), 0);
        map.mark(0);
        map.mark(2);
        assert_eq!(map.completed_bytes(), 1024 + 452);
        assert!(map.missing() == vec![1]);
        assert!(!map.is_complete());
    }

    #[test]
    fn rejects_bitmaps_of_the_wrong_size() {
        assert!(PieceMap::from_bits(2048, 1024, vec![0]).is_some());
        assert!(PieceMap::from_bits(2048, 1024, vec![0, 0]).is_none());
    }
}
