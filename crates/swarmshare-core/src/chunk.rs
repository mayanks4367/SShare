//! Fixed-size content-defined chunking with BLAKE3.
//!
//! Improvements over classic BitTorrent (SHA-1, tracker-bound):
//! - BLAKE3 (fast, parallel, 256-bit) per chunk + Merkle-root file id
//! - Content addressing => automatic deduplication across files/peers
//! - Optional per-chunk zstd compression + ChaCha20-Poly1305 encryption

use serde::{Deserialize, Serialize};

/// Default piece size: 256 KiB — good tradeoff for DHT + parallel fetch.
pub const CHUNK_SIZE: usize = 256 * 1024;

/// BLAKE3 hash of arbitrary bytes, hex encoded.
pub fn hash_bytes(data: &[u8]) -> String {
    blake3::hash(data).to_hex().to_string()
}

/// SHA-256 hash of arbitrary bytes, hex encoded.
///
/// Canonical hashing stays BLAKE3 (`hash_bytes`). SHA-256 exists as the
/// bridge format for browser clients (WebCrypto) and the HTTP gateway, so
/// web and native sides can verify the same bytes without WASM BLAKE3.
pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(data))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Chunk {
    /// Index within the file (0-based).
    pub index: u32,
    /// BLAKE3 hex digest of the *stored* (possibly compressed/encrypted) bytes.
    pub hash: String,
    /// Raw (pre-transform) length.
    pub raw_len: usize,
    /// Stored length on disk / wire.
    pub stored_len: usize,
    pub data: Vec<u8>,
}

pub struct Chunker {
    pub chunk_size: usize,
    pub compress: bool,
    pub compress_level: i32,
}

impl Default for Chunker {
    fn default() -> Self {
        Self {
            chunk_size: CHUNK_SIZE,
            compress: false,
            compress_level: 3,
        }
    }
}

impl Chunker {
    pub fn new(chunk_size: usize) -> Self {
        Self {
            chunk_size,
            compress: false,
            compress_level: 3,
        }
    }

    pub fn with_compression(mut self, level: i32) -> Self {
        self.compress = true;
        self.compress_level = level;
        self
    }

    /// Split raw file bytes into chunks, optionally zstd-compressing each.
    pub fn chunk_bytes(&self, data: &[u8]) -> Vec<Chunk> {
        if data.is_empty() {
            let stored = if self.compress {
                zstd::encode_all(std::io::empty(), self.compress_level).unwrap_or_default()
            } else {
                Vec::new()
            };
            return vec![Chunk {
                index: 0,
                hash: hash_bytes(&stored),
                raw_len: 0,
                stored_len: stored.len(),
                data: stored,
            }];
        }
        data.chunks(self.chunk_size)
            .enumerate()
            .map(|(i, piece)| {
                let stored = if self.compress {
                    zstd::encode_all(piece, self.compress_level).unwrap_or_else(|_| piece.to_vec())
                } else {
                    piece.to_vec()
                };
                Chunk {
                    index: i as u32,
                    hash: hash_bytes(&stored),
                    raw_len: piece.len(),
                    stored_len: stored.len(),
                    data: stored,
                }
            })
            .collect()
    }

    /// Decode (decompress) a stored chunk back to raw bytes.
    pub fn decode(&self, chunk: &Chunk) -> anyhow::Result<Vec<u8>> {
        if self.compress || is_zstd(chunk.data.as_slice()) {
            // Try decompress; fall back to raw if it was not compressed.
            match zstd::decode_all(chunk.data.as_slice()) {
                Ok(v) => Ok(v),
                Err(_) => Ok(chunk.data.clone()),
            }
        } else {
            Ok(chunk.data.clone())
        }
    }

    /// Merkle-style file id: BLAKE3 over concatenated chunk hashes.
    /// This is the global `file_id` announced on the DHT.
    pub fn file_id(chunks: &[Chunk]) -> String {
        let mut h = blake3::Hasher::new();
        for c in chunks {
            h.update(c.hash.as_bytes());
        }
        h.finalize().to_hex().to_string()
    }
}

fn is_zstd(data: &[u8]) -> bool {
    data.len() >= 4 && data[0] == 0x28 && data[1] == 0xB5 && data[2] == 0x2F && data[3] == 0xFD
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_roundtrip() {
        let data = b"hello swarmshare ".repeat(10000);
        let c = Chunker::default();
        let chunks = c.chunk_bytes(&data);
        assert!(!chunks.is_empty());
        let mut out = Vec::new();
        for ch in &chunks {
            out.extend_from_slice(&c.decode(ch).unwrap());
        }
        assert_eq!(out, data);
    }

    #[test]
    fn compressed_roundtrip() {
        let data = b"aaaaaaaaaaaaaaaaaaaaaaaaaaaa".repeat(20000);
        let c = Chunker::default().with_compression(3);
        let chunks = c.chunk_bytes(&data);
        // compressible => stored smaller than raw
        assert!(chunks[0].stored_len < chunks[0].raw_len);
        let mut out = Vec::new();
        for ch in &chunks {
            out.extend_from_slice(&c.decode(ch).unwrap());
        }
        assert_eq!(out, data);
    }

    #[test]
    fn file_id_stable() {
        let c = Chunker::default();
        let a = c.chunk_bytes(b"same data here");
        let b = c.chunk_bytes(b"same data here");
        assert_eq!(Chunker::file_id(&a), Chunker::file_id(&b));
    }

    #[test]
    fn sha256_bridge_vector() {
        // Well-known SHA-256("abc"); browsers must reproduce this via WebCrypto.
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(sha256_hex(b"abc").len(), 64);
    }
}
