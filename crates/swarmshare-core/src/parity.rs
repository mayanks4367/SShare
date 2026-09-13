//! XOR parity for cheap redundancy.
//!
//! Novel addition vs plain BitTorrent: for every group of N data chunks we
//! store one XOR parity block. Any *single* missing/corrupt chunk in the group
//! can be rebuilt from the remaining N-1 + parity — useful when the last
//! seeder disappears.
//!
//! Parity blocks are content-addressed like normal blocks (BLAKE3) and listed
//! in `FileManifest::parity_hashes` in group order.

use crate::chunk::{Chunk, hash_bytes};

/// Build parity blocks. Returns Vec<(parity_hash, parity_bytes)> in group order.
/// Groups are padded with zeros to the max chunk length in the group.
pub fn build_parity(chunks: &[Chunk], group: usize) -> Vec<(String, Vec<u8>)> {
    if group <= 1 || chunks.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for g in chunks.chunks(group) {
        let max_len = g.iter().map(|c| c.data.len()).max().unwrap_or(0);
        let mut acc = vec![0u8; max_len];
        for c in g {
            for (i, b) in c.data.iter().enumerate() {
                acc[i] ^= b;
            }
        }
        out.push((hash_bytes(&acc), acc));
    }
    out
}

/// Rebuild a missing chunk (by index-in-group) from siblings + parity.
pub fn repair(
    siblings: &[Vec<u8>],
    parity: &[u8],
    missing_len: usize,
) -> Vec<u8> {
    let mut acc = parity.to_vec();
    // trim/extend parity to missing_len semantics: XOR then truncate
    for s in siblings {
        if acc.len() < s.len() {
            acc.resize(s.len(), 0);
        }
        for (i, b) in s.iter().enumerate() {
            acc[i] ^= b;
        }
    }
    acc.truncate(missing_len);
    acc
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::Chunker;

    #[test]
    fn parity_repairs_one_loss() {
        let data = b"The quick brown fox jumps over the lazy dog. ".repeat(8000);
        let c = Chunker::new(64 * 1024);
        let chunks = c.chunk_bytes(&data);
        let group = 4;
        let parity = build_parity(&chunks, group);
        assert!(!parity.is_empty());
        // Simulate losing chunk 1 of first group
        let g0: Vec<Vec<u8>> = chunks[..group.min(chunks.len())]
            .iter()
            .map(|c| c.data.clone())
            .collect();
        let (ph, pdata) = &parity[0];
        assert_eq!(ph, &hash_bytes(pdata));
        let missing_idx = 1 % g0.len();
        let siblings: Vec<Vec<u8>> = g0
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != missing_idx)
            .map(|(_, v)| v.clone())
            .collect();
        let rebuilt = repair(&siblings, pdata, g0[missing_idx].len());
        assert_eq!(rebuilt, g0[missing_idx]);
    }
}
