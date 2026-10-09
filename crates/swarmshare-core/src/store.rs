//! On-disk content-addressed block store.
//!
//! Layout under `<data_dir>/`:
//! ```text
//! blocks/<chunk_hash>          — raw stored chunk bytes
//! manifests/<file_id>.json     — FileManifest
//! downloads/<file_id>.state    — resume bitfield JSON
//! files/<file_name>            — assembled outputs (via assemble)
//! ```

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use crate::manifest::FileManifest;

pub struct BlockStore {
    root: PathBuf,
}

impl BlockStore {
    pub fn new(root: impl Into<PathBuf>) -> anyhow::Result<Self> {
        let root = root.into();
        for d in ["blocks", "manifests", "downloads", "files"] {
            std::fs::create_dir_all(root.join(d))?;
        }
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn block_path(&self, hash: &str) -> PathBuf {
        self.root.join("blocks").join(hash)
    }
    fn manifest_path(&self, file_id: &str) -> PathBuf {
        self.root
            .join("manifests")
            .join(format!("{}.json", file_id))
    }
    fn state_path(&self, file_id: &str) -> PathBuf {
        self.root.join("downloads").join(format!("{}.state", file_id))
    }

    // ---- blocks ----
    pub fn has_block(&self, hash: &str) -> bool {
        self.block_path(hash).exists()
    }

    pub fn put_block(&self, hash: &str, data: &[u8]) -> anyhow::Result<()> {
        let p = self.block_path(hash);
        if !p.exists() {
            std::fs::write(p, data)?;
        }
        Ok(())
    }

    pub fn get_block(&self, hash: &str) -> anyhow::Result<Vec<u8>> {
        Ok(std::fs::read(self.block_path(hash))?)
    }

    // ---- manifests ----
    pub fn put_manifest(&self, m: &FileManifest) -> anyhow::Result<()> {
        std::fs::write(self.manifest_path(&m.file_id), m.to_json()?)?;
        Ok(())
    }

    pub fn get_manifest(&self, file_id: &str) -> anyhow::Result<FileManifest> {
        let s = std::fs::read_to_string(self.manifest_path(file_id))?;
        Ok(FileManifest::from_json(&s)?)
    }

    pub fn list_manifests(&self) -> anyhow::Result<Vec<FileManifest>> {
        let mut out = Vec::new();
        let dir = self.root.join("manifests");
        for e in std::fs::read_dir(dir)? {
            let e = e?;
            if e.path().extension().and_then(|s| s.to_str()) == Some("json") {
                if let Ok(s) = std::fs::read_to_string(e.path()) {
                    if let Ok(m) = FileManifest::from_json(&s) {
                        out.push(m);
                    }
                }
            }
        }
        out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(out)
    }

    // ---- resume bitfield ----
    /// Set of chunk indexes already present locally for `file_id`.
    pub fn load_progress(&self, file_id: &str, num_chunks: usize) -> HashSet<usize> {
        let p = self.state_path(file_id);
        if let Ok(s) = std::fs::read_to_string(p) {
            if let Ok(v) = serde_json::from_str::<Vec<usize>>(&s) {
                return v.into_iter().filter(|&i| i < num_chunks).collect();
            }
        }
        HashSet::new()
    }

    pub fn save_progress(&self, file_id: &str, have: &HashSet<usize>) -> anyhow::Result<()> {
        let mut v: Vec<usize> = have.iter().copied().collect();
        v.sort_unstable();
        std::fs::write(self.state_path(file_id), serde_json::to_string(&v)?)?;
        Ok(())
    }

    /// Scan which chunks of a manifest are already in the block store.
    pub fn have_set(&self, m: &FileManifest) -> HashSet<usize> {
        m.chunk_hashes
            .iter()
            .enumerate()
            .filter(|(_, h)| self.has_block(h))
            .map(|(i, _)| i)
            .collect()
    }

    // ---- assembly ----
    /// Assemble a complete file from blocks into `<root>/files/<file_name>`.
    /// Verifies every chunk hash before writing.
    pub fn assemble(&self, m: &FileManifest, out_path: Option<&Path>) -> anyhow::Result<PathBuf> {
        let dest = match out_path {
            Some(p) => p.to_path_buf(),
            None => self.root.join("files").join(&m.file_name),
        };
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = dest.with_extension("swarmshare-tmp");
        let mut f = std::fs::File::create(&tmp)?;
        {
            use std::io::Write;
            let chunker = m._chunker();
            for (i, h) in m.chunk_hashes.iter().enumerate() {
                let stored = self.get_block(h).map_err(|_| {
                    anyhow::anyhow!("missing chunk {} ({}...) for {}", i, &h[..12], m.file_id)
                })?;
                if crate::chunk::hash_bytes(&stored) != *h {
                    anyhow::bail!("chunk {} failed hash check", i);
                }
                let raw = chunker.decode(&crate::chunk::Chunk {
                    index: i as u32,
                    hash: h.clone(),
                    raw_len: stored.len(),
                    stored_len: stored.len(),
                    data: stored,
                })?;
                // If encrypted, caller must decrypt before assemble; raw here is ciphertext.
                f.write_all(&raw)?;
            }
        }
        std::fs::rename(&tmp, &dest)?;
        Ok(dest)
    }

    /// Import a local file: chunk -> store blocks -> build manifest.
    pub fn import_file(
        &self,
        path: &Path,
        keywords: Vec<String>,
        compress: bool,
        parity_group: usize,
    ) -> anyhow::Result<FileManifest> {
        let bytes = std::fs::read(path)?;
        let file_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("unnamed")
            .to_string();
        let mime = guess_mime(&file_name).to_string();
        self.import_bytes(&file_name, &bytes, &mime, keywords, compress, parity_group)
    }

    /// Import raw bytes (e.g. from an HTTP upload): chunk -> store blocks
    /// -> build manifest with SHA-256 bridge hashes for web clients.
    pub fn import_bytes(
        &self,
        file_name: &str,
        bytes: &[u8],
        mime: &str,
        keywords: Vec<String>,
        compress: bool,
        parity_group: usize,
    ) -> anyhow::Result<FileManifest> {
        let chunker = if compress {
            crate::chunk::Chunker::default().with_compression(3)
        } else {
            crate::chunk::Chunker::default()
        };
        let chunks = chunker.chunk_bytes(bytes);
        for c in &chunks {
            self.put_block(&c.hash, &c.data)?;
        }
        let hashes: Vec<String> = chunks.iter().map(|c| c.hash.clone()).collect();
        let mut m = FileManifest::new(
            file_name.to_string(),
            bytes.len() as u64,
            hashes,
            chunker.chunk_size,
            keywords,
        );
        m.compressed = compress;
        m.mime = mime.to_string();
        m.sha256 = Some(crate::chunk::sha256_hex(bytes));
        m.chunk_sha256 = chunks
            .iter()
            .map(|c| crate::chunk::sha256_hex(&c.data))
            .collect();

        // Optional XOR parity: 1 parity block per group (recover any 1 loss per group).
        if parity_group > 1 && chunks.len() > 1 {
            let parity = crate::parity::build_parity(&chunks, parity_group);
            for (ph, pdata) in parity {
                self.put_block(&ph, &pdata)?;
                m.parity_hashes.push(ph);
            }
            m.parity_group = parity_group;
        }

        self.put_manifest(&m)?;
        Ok(m)
    }
}

/// Best-effort MIME guess from a file name for browser downloads.
/// Unknown extensions fall back to `application/octet-stream`.
pub fn guess_mime(file_name: &str) -> &'static str {    match file_name.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "json" => "application/json",
        "txt" | "md" | "log" => "text/plain",
        "csv" => "text/csv",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_store(tag: &str) -> (BlockStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "swarmshare-test-{}-{}-{}",
            std::process::id(),
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let store = BlockStore::new(&dir).expect("store");
        (store, dir)
    }

    #[test]
    fn import_bytes_roundtrip_with_bridge_hashes() {
        let (store, dir) = scratch_store("bytes");
        let data = b"web bridge test payload ".repeat(30000);
        let m = store
            .import_bytes("demo.bin", &data, "application/octet-stream", vec!["demo".into()], false, 0)
            .expect("import");

        // SHA-256 bridge: whole file + every stored chunk.
        assert_eq!(m.sha256.as_deref(), Some(crate::chunk::sha256_hex(&data).as_str()));
        assert_eq!(m.chunk_sha256.len(), m.chunk_hashes.len());
        for (i, h) in m.chunk_hashes.iter().enumerate() {
            let stored = store.get_block(h).expect("block");
            assert!(m.verify_chunk(i, &stored));
            assert!(m.verify_chunk_sha256(i, &stored));
        }

        // Persisted manifest reloads (simulates a fresh daemon/gateway).
        let re = store.get_manifest(&m.file_id).expect("reload");
        assert_eq!(re.sha256, m.sha256);

        // Assembly reproduces the exact bytes.
        let out = store.assemble(&m, None).expect("assemble");
        assert_eq!(std::fs::read(out).expect("read"), data);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_manifest_without_bridge_fields_still_parses() {
        let json = r#"{
            "file_id": "ab", "file_name": "old.bin", "file_size": 3,
            "chunk_size": 262144, "chunk_hashes": ["cd"],
            "parity_group": 0, "compressed": false, "encrypted": false,
            "created_at": 1
        }"#;
        let m = FileManifest::from_json(json).expect("parse");
        assert_eq!(m.sha256, None);
        assert!(m.chunk_sha256.is_empty());
        assert_eq!(m.mime, "");
        assert!(!m.verify_chunk_sha256(0, b"anything"));
        // ...but re-serializing keeps the new fields present for new readers.
        let v: serde_json::Value = serde_json::from_str(&m.to_json().unwrap()).unwrap();
        assert!(v.get("sha256").is_some());
        assert!(v.get("chunk_sha256").is_some());
    }

    #[test]
    fn mime_guess_covers_browser_cases() {
        assert_eq!(guess_mime("a.png"), "image/png");
        assert_eq!(guess_mime("a.MP4"), "video/mp4");
        assert_eq!(guess_mime("noext"), "application/octet-stream");
    }
}
