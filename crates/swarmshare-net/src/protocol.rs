//! Wire protocol: chunk + manifest exchange over libp2p request-response (CBOR).

use serde::{Deserialize, Serialize};

/// Ask a peer for one stored chunk by its content hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkRequest {
    /// BLAKE3 hex of the stored chunk bytes.
    pub hash: String,
    /// File id (for accounting / choke decisions).
    pub file_id: String,
    pub index: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkResponse {
    /// Stored chunk bytes (possibly compressed/encrypted). Empty = not found.
    pub data: Vec<u8>,
    pub found: bool,
}

/// Ask a peer for a manifest by file_id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestRequest {
    pub file_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestResponse {
    pub manifest_json: String,
    pub found: bool,
}
