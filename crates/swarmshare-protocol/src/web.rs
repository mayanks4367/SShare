//! Browser-facing transfer manifest + descriptors.
//!
//! [`WebManifest`] is what the Rust HTTP gateway serves at
//! `GET /api/web-manifest/:file_id`. It carries everything a browser needs
//! to fetch (WebRTC primary, HTTP chunk relay as deliberate fallback) and
//! verify a file — and no file bytes.

use serde::{Deserialize, Serialize};

/// Everything a browser needs to fetch + verify one file.
///
/// Hashing is dual-format by design:
/// - `chunk_hashes_blake3` + `file_id`: canonical SShare addressing
///   (native CLI, DHT, block store).
/// - `chunk_hashes_sha256` + `sha256`: WebCrypto-verifiable bridge
///   (browsers cannot practically run BLAKE3 without WASM).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebManifest {
    /// BLAKE3 Merkle root over chunk hashes (== native `file_id`, DHT key).
    pub file_id: String,
    pub file_name: String,
    /// MIME type for downloads; defaults to octet-stream when unknown.
    pub mime: String,
    /// Raw file size in bytes.
    pub file_size: u64,
    /// Logical chunk size in bytes (stored payload per chunk sans framing).
    pub chunk_size: usize,
    pub total_chunks: usize,
    /// Hex BLAKE3 per stored chunk, index-aligned.
    pub chunk_hashes_blake3: Vec<String>,
    /// Hex SHA-256 per stored chunk, index-aligned (may be empty for
    /// pre-web manifests; then only whole-file `sha256` can be checked).
    #[serde(default)]
    pub chunk_hashes_sha256: Vec<String>,
    /// Hex SHA-256 over the whole raw file (None for pre-web manifests).
    #[serde(default)]
    pub sha256: Option<String>,
    /// Whether stored chunks are zstd-compressed (browser must decompress;
    /// plain `fetch` fallback serves stored bytes as-is).
    #[serde(default)]
    pub compressed: bool,
    /// Unix millis when shared.
    #[serde(default)]
    pub created_at: u64,
}

impl WebManifest {
    pub fn mime_or_default(&self) -> &str {
        if self.mime.is_empty() {
            "application/octet-stream"
        } else {
            &self.mime
        }
    }

    /// Structural validation (lengths line up, sizes sane).
    pub fn validate(&self) -> Result<(), String> {
        if self.file_id.is_empty() {
            return Err("file_id required".to_string());
        }
        if self.file_name.is_empty() {
            return Err("file_name required".to_string());
        }
        if self.total_chunks != self.chunk_hashes_blake3.len() {
            return Err(format!(
                "total_chunks {} != blake3 hashes {}",
                self.total_chunks,
                self.chunk_hashes_blake3.len()
            ));
        }
        if !self.chunk_hashes_sha256.is_empty()
            && self.chunk_hashes_sha256.len() != self.total_chunks
        {
            return Err("chunk_hashes_sha256 length mismatch".to_string());
        }
        if let Some(s) = &self.sha256 {
            if !is_hex_sha256(s) {
                return Err("sha256 must be 64 lowercase hex chars".to_string());
            }
        }
        Ok(())
    }
}

pub fn is_hex_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Lightweight transfer header (signaling TRANSFER_* + gateway responses).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferDescriptor {
    #[serde(rename = "transferId")]
    pub transfer_id: String,
    #[serde(rename = "fileName")]
    pub file_name: String,
    #[serde(rename = "fileSize")]
    pub file_size: u64,
    pub chunks: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> WebManifest {
        WebManifest {
            file_id: "ab".into(),
            file_name: "a.bin".into(),
            mime: "application/octet-stream".into(),
            file_size: 10,
            chunk_size: 262144,
            total_chunks: 1,
            chunk_hashes_blake3: vec!["cd".into()],
            chunk_hashes_sha256: vec!["ef".repeat(32)],
            sha256: Some("ab".repeat(32)),
            compressed: false,
            created_at: 1,
        }
    }

    #[test]
    fn web_manifest_validates() {
        assert!(sample().validate().is_ok());
        let mut bad = sample();
        bad.total_chunks = 2;
        assert!(bad.validate().is_err());
        let mut bad2 = sample();
        bad2.sha256 = Some("xyz".into());
        assert!(bad2.validate().is_err());
    }

    #[test]
    fn legacy_json_without_bridge_fields_parses() {
        let v = serde_json::json!({
            "file_id": "ab", "file_name": "a.bin", "mime": "",
            "file_size": 10, "chunk_size": 262144, "total_chunks": 1,
            "chunk_hashes_blake3": ["cd"]
        });
        let m: WebManifest = serde_json::from_value(v).unwrap();
        assert_eq!(m.sha256, None);
        assert!(m.chunk_hashes_sha256.is_empty());
        assert!(m.validate().is_ok());
        assert_eq!(m.mime_or_default(), "application/octet-stream");
    }

    #[test]
    fn descriptor_uses_camel_case_wire_names() {
        let d = TransferDescriptor {
            transfer_id: "SS-X".into(),
            file_name: "a.bin".into(),
            file_size: 10,
            chunks: 1,
        };
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["transferId"], serde_json::json!("SS-X"));
        assert_eq!(v["fileName"], serde_json::json!("a.bin"));
        assert_eq!(v["fileSize"], serde_json::json!(10));
    }
}
