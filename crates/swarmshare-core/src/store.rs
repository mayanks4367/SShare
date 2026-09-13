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
        let chunker = if compress {
            crate::chunk::Chunker::default().with_compression(3)
        } else {
            crate::chunk::Chunker::default()
        };
        let chunks = chunker.chunk_bytes(&bytes);
        for c in &chunks {
            self.put_block(&c.hash, &c.data)?;
        }
        let hashes: Vec<String> = chunks.iter().map(|c| c.hash.clone()).collect();
        let mut m = FileManifest::new(
            file_name,
            bytes.len() as u64,
            hashes,
            chunker.chunk_size,
            keywords,
        );
        m.compressed = compress;

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
