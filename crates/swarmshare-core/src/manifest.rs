//! File manifest: the ".torrent" equivalent, but content-addressed + searchable.

use serde::{Deserialize, Serialize};

use crate::chunk::Chunker;

/// A shareable file descriptor. `file_id` is the DHT key.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileManifest {
    /// BLAKE3 Merkle root over chunk hashes.
    pub file_id: String,
    pub file_name: String,
    pub file_size: u64,
    pub chunk_size: usize,
    /// Hex BLAKE3 per chunk (index == position).
    pub chunk_hashes: Vec<String>,
    /// Optional XOR parity hashes (see parity.rs).
    #[serde(default)]
    pub parity_hashes: Vec<String>,
    pub parity_group: usize,
    /// Searchable keywords (lowercased).
    #[serde(default)]
    pub keywords: Vec<String>,
    pub compressed: bool,
    pub encrypted: bool,
    /// Unix millis when shared.
    pub created_at: u64,
    /// Human note.
    #[serde(default)]
    pub description: String,
}

impl FileManifest {
    pub fn new(
        file_name: String,
        file_size: u64,
        chunk_hashes: Vec<String>,
        chunk_size: usize,
        keywords: Vec<String>,
    ) -> Self {
        // file_id = blake3 over concatenated hashes (same as Chunker::file_id)
        let mut h = blake3::Hasher::new();
        for c in &chunk_hashes {
            h.update(c.as_bytes());
        }
        Self {
            file_id: h.finalize().to_hex().to_string(),
            file_name,
            file_size,
            chunk_size,
            chunk_hashes,
            parity_hashes: Vec::new(),
            parity_group: 0,
            keywords: keywords.into_iter().map(|k| k.to_lowercase()).collect(),
            compressed: false,
            encrypted: false,
            created_at: now_millis(),
            description: String::new(),
        }
    }

    pub fn num_chunks(&self) -> usize {
        self.chunk_hashes.len()
    }

    /// DHT provider key for chunk `i`: `chunk:<file_id>:<index>`
    pub fn chunk_key(&self, index: usize) -> String {
        format!("chunk:{}:{}", self.file_id, index)
    }

    /// DHT key for the manifest itself: `file:<file_id>`
    pub fn manifest_key(&self) -> String {
        format!("file:{}", self.file_id)
    }

    /// DHT search keys: `index:<keyword>` for each keyword.
    pub fn index_keys(&self) -> Vec<String> {
        self.keywords
            .iter()
            .map(|k| format!("index:{}", k.to_lowercase()))
            .collect()
    }

    pub fn verify_chunk(&self, index: usize, data: &[u8]) -> bool {
        self.chunk_hashes
            .get(index)
            .map(|h| &crate::chunk::hash_bytes(data) == h)
            .unwrap_or(false)
    }

    pub fn to_json(&self) -> anyhow::Result<String> {
        Ok(serde_json::to_string_pretty(self)?)
    }

    pub fn from_json(s: &str) -> anyhow::Result<Self> {
        Ok(serde_json::from_str(s)?)
    }

    /// Recompute file_id from hashes (useful after adding parity etc.)
    pub fn recompute_id(&mut self) {
        let mut h = blake3::Hasher::new();
        for c in &self.chunk_hashes {
            h.update(c.as_bytes());
        }
        self.file_id = h.finalize().to_hex().to_string();
    }

    pub fn _chunker(&self) -> Chunker {
        let mut c = Chunker::new(self.chunk_size);
        if self.compressed {
            c = c.with_compression(3);
        }
        c
    }
}

fn now_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
