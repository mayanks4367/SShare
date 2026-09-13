# SwarmShare Protocol (v1)

All keys/values below live on the **Kademlia DHT** unless noted.
Transports: **TCP** (`/ip4/.../tcp/...`) + **QUIC over UDP** (`/udp/.../quic-v1`),
Noise-encrypted, Yamux-multiplexed. Local discovery via **mDNS**, identity via
**Identify**, live announcements via **Gossipsub** topic `swarmshare-files-v1`.

## 1. Identities

- Ed25519 libp2p `Keypair`, persisted at `<data-dir>/key.bin` (protobuf).
- `PeerId` = multihash of public key. Printed on share/daemon.

## 2. Chunking

- Fixed `CHUNK_SIZE = 256 * 1024` bytes (last piece shorter).
- Optional `zstd(level)` per chunk, then optional `ChaCha20-Poly1305`.
  - Nonce layout: `index_le32 ‖ rand64` prepended to ciphertext (self-contained).
- `chunk_hash = BLAKE3_hex(stored_bytes)`.
- `file_id = BLAKE3_hex(chunk_hash_0 ‖ chunk_hash_1 ‖ …)` (Merkle root).

## 3. Manifest (the `.torrent` equivalent)

JSON (`FileManifest`), stored at `<data>/manifests/<file_id>.json`:

```json
{
  "file_id": "blake3-hex",
  "file_name": "movie.mkv",
  "file_size": 123456,
  "chunk_size": 262144,
  "chunk_hashes": ["ab..", "cd.."],
  "parity_hashes": ["ef.."],
  "parity_group": 4,
  "keywords": ["movie", "4k"],
  "compressed": true,
  "encrypted": false,
  "created_at": 1757780000000,
  "description": ""
}
```

## 4. DHT keys

| Key | Value | Op |
|---|---|---|
| `<file_id>` (provider record) | provider set | `start_providing` / `get_providers` |
| `file:<file_id>` | manifest JSON bytes | `put_record` / `get_record` (Quorum::One) |
| `index:<keyword-lower>` | JSON `["<file_id>", …]` (merged read-modify-write) | `put_record` / `get_record` |
| `chunk:<file_id>:<i>` | *reserved* (v1 assumes full providers; v2 will provide per-chunk for partial seeding) | — |

Provider + manifest split is deliberate: **providers** answer "who",
**records** answer "what". Direct `ManifestRequest` RPC is the fast path;
DHT records are the fallback.

## 5. Gossipsub

Topic `swarmshare-files-v1`, `MessageAuthenticity::Signed`:

```json
{"file_id": "…", "file_name": "…", "file_size": 123, "chunks": 4}
```

Peers log `📢 gossip: …` on receipt. Future: `HAVE {file_id, bitfield}` /
`WANT` for true rarest-first with partial peers.

## 6. Request–Response RPCs (CBOR)

- `/swarmshare/chunk/1.0.0`: `ChunkRequest{hash, file_id, index}` →
  `ChunkResponse{data, found}`. Auto-served from `BlockStore` if present,
  else forwarded to app (choke-aware) which replies `found=false`.
- `/swarmshare/manifest/1.0.0`: `ManifestRequest{file_id}` →
  `ManifestResponse{manifest_json, found}`. Same serving rule.

Timeouts: 20 s per chunk request, 3-attempt provider failover ordered by
reputation.

## 7. Download algorithm (CLI)

```
providers = direct --peer dials ∪ DHT get_providers(file_id) (4× retry)
manifest  = first ManifestRpc hit, else DHT get_record(file:<id>)
have      = store.have_set ∪ resume bitfield
picker.advertise(each provider → all chunks)   # v1; v2 uses HAVE gossip
order     = rarest-first drain of missing
parallel(N): for chunk in order:
    peers_try = reputation.rank(providers)
    data = first success (verify BLAKE3 / Poly1305, else report_failure)
    put_block; have.insert; save bitfield every 5
retry failures once; parity-repair hint; assemble → re-provide
```

Reputation: EWMA, `success: s←0.8s+0.2`, `failure: s←0.8s`, start 0.5.
Choking (upload side): `ChokeManager{slots=4}`, `rechoke()` keeps top
contributors + 1 optimistic unchoke per 10 s; unknown peers allowed at bootstrap.

## 8. Parity

`parity_group = N` ⇒ one XOR block per N data chunks, content-addressed and
listed in `parity_hashes`. Repair: `missing = parity ⊕ (⊕ siblings)`, truncated
to the missing chunk length. Recovers **any single loss per group**.

## 9. Encryption (demo-grade, documented tradeoff)

- Sharer: random 32 B file key → per-chunk encrypt → rewrite hashes → wrap file
  key with `BLAKE3("swarmshare-v1:"+file_id+":"+passphrase)` → sidecar `.keywrap`.
- Downloader (v1 simplification): **re-derive** the same KEK deterministically
  from `(passphrase, file_id)` instead of unwrapping — no separate key exchange
  needed, but nonces must never repeat across files in production.
- Production upgrade: Argon2id + random salt in manifest + XChaCha20-Poly1305.

## 10. HTTP gateway

- `GET /` dashboard (have/total per file)
- `GET /api/files`, `GET /api/stats`, `GET /manifest/<id>`
- `GET /file/<id>` → `409` with progress if incomplete, else
  `application/octet-stream` with `Content-Disposition: attachment`.
