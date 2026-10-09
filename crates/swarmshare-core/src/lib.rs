//! SwarmShare Core — content-addressed chunking, manifests, store,
//! rarest-first picker, XOR parity and optional crypto/compression.

pub mod chunk;
pub mod crypto;
pub mod manifest;
pub mod parity;
pub mod picker;
pub mod store;

pub use chunk::{Chunk, Chunker, CHUNK_SIZE, hash_bytes, sha256_hex};
pub use manifest::FileManifest;
pub use picker::{ChokeManager, PeerReputation, RarestFirstPicker};
pub use store::BlockStore;
