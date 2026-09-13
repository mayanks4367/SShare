//! Optional passphrase encryption (ChaCha20-Poly1305) for private sharing.
//!
//! Design: a random 32-byte file key is generated per file; the key itself is
//! encrypted with a key derived from the user passphrase (BLAKE3) and stored
//! in the manifest sidecar. Here we expose low-level chunk encrypt/decrypt;
//! key management lives in the CLI layer.

use anyhow::Context;
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce, aead::{Aead, KeyInit}};
use rand::RngCore;

/// Encrypt a chunk with `key32`. Nonce = 12 bytes: 4-byte chunk index + 8 random.
pub fn encrypt_chunk(key32: &[u8; 32], index: u32, plaintext: &[u8]) -> anyhow::Result<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key32));
    let mut nonce_bytes = [0u8; 12];
    nonce_bytes[..4].copy_from_slice(&index.to_le_bytes());
    rand::thread_rng().fill_bytes(&mut nonce_bytes[4..]);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let mut ct = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| anyhow::anyhow!("encrypt failed: {}", e))?;
    // prepend nonce so decrypt is self-contained
    let mut out = nonce_bytes.to_vec();
    out.append(&mut ct);
    Ok(out)
}

pub fn decrypt_chunk(key32: &[u8; 32], payload: &[u8]) -> anyhow::Result<Vec<u8>> {
    if payload.len() < 12 + 16 {
        anyhow::bail!("ciphertext too short");
    }
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key32));
    let nonce = Nonce::from_slice(&payload[..12]);
    cipher
        .decrypt(nonce, &payload[12..])
        .map_err(|e| anyhow::anyhow!("decrypt failed (wrong passphrase?): {}", e))
}

/// Derive a 32-byte key from a passphrase via BLAKE3 (simple KDF, demo-grade).
/// For production use Argon2; we avoid the extra dep for a semester project
/// but document the upgrade path.
pub fn key_from_passphrase(pass: &str, file_id_salt: &str) -> [u8; 32] {
    let mut h = blake3::Hasher::new();
    h.update(b"swarmshare-v1:");
    h.update(file_id_salt.as_bytes());
    h.update(b":");
    h.update(pass.as_bytes());
    let out = h.finalize();
    let mut k = [0u8; 32];
    k.copy_from_slice(out.as_bytes());
    k
}

pub fn random_key() -> [u8; 32] {
    let mut k = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut k);
    k
}

/// Wrap/unwrap a file key with a passphrase-derived key (for sharing the key).
pub fn wrap_key(pass: &str, salt: &str, file_key: &[u8; 32]) -> anyhow::Result<Vec<u8>> {
    let kek = key_from_passphrase(pass, salt);
    encrypt_chunk(&kek, u32::MAX, file_key).context("wrap key")
}

pub fn unwrap_key(pass: &str, salt: &str, wrapped: &[u8]) -> anyhow::Result<[u8; 32]> {
    let kek = key_from_passphrase(pass, salt);
    let raw = decrypt_chunk(&kek, wrapped)?;
    if raw.len() != 32 {
        anyhow::bail!("bad unwrapped key length");
    }
    let mut k = [0u8; 32];
    k.copy_from_slice(&raw);
    Ok(k)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_enc_roundtrip() {
        let k = random_key();
        let pt = b"secret piece data".repeat(100);
        let ct = encrypt_chunk(&k, 7, &pt).unwrap();
        assert_ne!(ct, pt);
        assert_eq!(decrypt_chunk(&k, &ct).unwrap(), pt);
    }
}
