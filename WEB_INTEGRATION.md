# SShare Web Integration (Rust ↔ browser)

How the existing Rust project and the WebRTC web application fit together.
Nothing here rewrites the Rust core: `swarmshare-core` gained only additive
bridge APIs, the CLI is unchanged, and bulk file data stays peer-to-peer.

```
┌─────────────┐  WebRTC DataChannel   ┌─────────────┐
│   Browser   │◄═════════════════════►│   Browser   │  primary: file bytes
└──────┬──────┘  chunks (256 KiB      └──────┬──────┘  P2P, never via server
       │         logical, 16 KiB slices)     │
       │ signaling (rooms/SDP/ICE)           │
       ▼                                     ▼
┌─────────────────────────────────────────────────┐
│ signaling/ (Node WS, :8787)  no file bytes ever │
└─────────────────────────────────────────────────┘

       │ metadata + deliberate fallback only
       ▼
┌─────────────────────────────────────────────────┐
│ Rust gateway (daemon/share --gateway, :8080)     │
│ BlockStore + FileManifest + web-manifest + chunk │
│ relay + upload. Same store the CLI seeds from.   │
└─────────────────────────────────────────────────┘
```

## 1. Component responsibilities

| Component | Owns | Never does |
|---|---|---|
| `swarmshare-core` | chunking (256 KiB), BLAKE3 hashing, `FileManifest`, `BlockStore`, picker/reputation, parity, crypto | networking, HTTP |
| `swarmshare-net` | libp2p: Kademlia DHT, Gossipsub, mDNS, chunk/manifest RPC | browser protocols |
| `swarmshare-protocol` (new) | shared types: signaling envelope, `WebManifest`, `TransferState` + validation | I/O, sockets |
| `swarmshare` CLI + gateway | P2P seeding, dashboard, **web API** (metadata + fallback relay) | proxying P2P bulk traffic |
| `signaling/` | private rooms, SDP/ICE relay, presence, transfer headers | storing/proxying files |
| web app (`sshareweb/frontend`) | UI, WebRTC transfer, SHA-256 verify, gateway fallback client | trusting the server for integrity (always verifies) |

Reusable library APIs (all pre-existing except ★):

- file discovery: DHT `get_providers` / `index:<kw>` records (`swarmshare-net`); web uses share codes + gateway lookup instead.
- chunking: `Chunker::chunk_bytes / decode` ★ plus `BlockStore::import_bytes` (raw bytes, e.g. HTTP upload).
- hashing: `hash_bytes` (BLAKE3, canonical) ★ plus `sha256_hex` bridge (browser-verifiable).
- integrity: `FileManifest::verify_chunk` (BLAKE3) ★ plus `verify_chunk_sha256` + whole-file `sha256`.
- metadata: `FileManifest::{to_json, from_json, manifest_key, chunk_key}` ★ plus `WebManifest` (protocol crate).
- transfer state: `BlockStore::{load_progress, save_progress, have_set}` (resume bitfield); `TransferState` DAG (protocol crate) mirrors the TS phases.
- storage: `BlockStore` (`blocks/`, `manifests/`, `downloads/`, `files/`).
- peer management: `PeerReputation` / `ChokeManager` (native); `PEER_JOINED/PEER_LEFT` (web presence).
- networking: libp2p swarm (native); `RTCPeerConnection` (web). Both move the same logical chunks.

## 2. Transport boundaries

- **REST/HTTP (Rust gateway)**: metadata, inventory, publishing, and the
  *deliberate* per-chunk fallback relay. Never the primary bulk path.
- **WebSocket (signaling/)**: rooms, SDP offer/answer, ICE, presence,
  `TRANSFER_READY/COMPLETE` headers. No file bytes (enforced, tested).
- **WebRTC DataChannel (browser↔browser)**: `meta` + `4-byte-index + payload`
  frames + `done/cancel` (see `web-prototype` engine). Primary bulk path.
- **libp2p (native↔native)**: `ChunkRequest/Response`, `ManifestRequest/Response` (unchanged).

## 3. REST endpoints (gateway)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | human dashboard (unchanged) |
| `GET` | `/api/health` ★ | `{ok, peer_id, version, files, total_bytes}` |
| `GET` | `/api/files` | native manifests JSON (unchanged) |
| `GET` | `/api/stats` | counters (unchanged) |
| `GET` | `/manifest/:file_id` | native manifest JSON (unchanged) |
| `GET` | `/api/web-manifest/:file_id` ★ | `WebManifest` JSON (browser fetch+verify plan) |
| `GET` | `/api/chunks/:file_id/:index` ★ | one stored chunk, `application/octet-stream` + `x-chunk-hash-{blake3,sha256}`, `x-chunk-index`, `x-total-chunks`, immutable cache |
| `POST` | `/api/files/upload?name=&keywords=&compress=&parity=&mime=` ★ | raw body → `import_bytes` → `201 {manifest, web_manifest}` (512 MiB cap) |
| `GET` | `/file/:file_id` | whole assembled file (unchanged; direct download, not P2P) |

CORS: `access-control-allow-origin: *` (+ preflight `204`). The gateway is
LAN-trusted by design; do not expose it to the public internet as-is.

## 4. Metadata formats

Native (`FileManifest`, `manifest.rs`) is canonical. Bridge fields (all
`#[serde(default)]`, old manifests still parse):
`sha256: Option<String>` (whole raw file), `chunk_sha256: Vec<String>`
(per stored chunk), `mime: String`.

Browser (`WebManifest`, `swarmshare-protocol::web`):

```json
{
  "file_id": "<blake3-merkle == native file_id>",
  "file_name": "photo.png", "mime": "image/png",
  "file_size": 123456, "chunk_size": 262144, "total_chunks": 4,
  "chunk_hashes_blake3": ["…"], "chunk_hashes_sha256": ["…"],
  "sha256": "<whole-file hex>", "compressed": false, "created_at": 1
}
```

TS `TransferMetadata` (live P2P sessions) maps: `transferId` = per-file
session id, `fileName/fileSize/chunkSize/totalChunks/checksum(SHA-256)` =
same semantics at 64 KiB logical chunks. The two layers meet at SHA-256:
a browser can verify gateway bytes with WebCrypto; the CLI verifies with
BLAKE3. `WebManifest::validate()` enforces length/shape agreement.

## 5. Identifiers

| ID | Format | Scope | Minted by |
|---|---|---|---|
| room / share code | `SS-XXXXXX` (`[A-Z0-9-]{3,32}`) | signaling session, ~30 min TTL | signaling server (`CREATE_ROOM`) |
| web transferId | `SS-XXXXXX` | one file inside a session | sender (`generateSessionId`) |
| file_id | 64-char BLAKE3 hex (Merkle root) | content, permanent | `Chunker::file_id` / `FileManifest::new` |
| chunk | `(file_id, index)` + content hashes | content | chunking |
| clientId | UUID | socket presence | signaling server (`WELCOME`) |

## 6. Checksums

- Canonical: BLAKE3 per stored chunk; `file_id` = BLAKE3 over concatenated
  chunk-hash strings. Verified by CLI/gateway on assemble/serve.
- Bridge: SHA-256 per stored chunk + whole raw file, computed at import
  (`import_file`/`import_bytes`), served in manifests/headers, verified by
  browsers (WebCrypto) per chunk and at completion. A mismatch fails the
  transfer even though the channel (DTLS) was intact.

## 7. Transfer state model (`swarmshare-protocol::state`)

`idle → file-selected → creating-session → waiting-for-peer → peer-connected
→ transferring ⇄ paused → verifying → complete`, with `connecting` for the
joining side and `cancelled/failed` from anywhere (`TransferState::can_transition_to`
encodes the DAG; terminal: complete/cancelled/failed). The web UI phases map
1:1; the CLI download loop maps `transferring → verifying → complete`.

## 8. Fallback policy (explicit)

1. WebRTC DataChannel P2P (default; STUN, TURN later).
2. If no P2P channel: user-invoked **gateway fallback** — browser fetches
   `web-manifest`, then `GET /api/chunks/:id/:i` per chunk with progress,
   verifying per-chunk + whole-file SHA-256. Opt-in per download, never silent.
3. Native libp2p path is unaffected and stays primary for CLI peers.

## 9. Preserved CLI behavior

All commands (`share/download/search/daemon/status/demo`) and old gateway
routes are byte-for-byte compatible; `cargo test` covers old + new paths.
`share`/`daemon` now also write bridge hashes (new manifests verify from both
stacks). Uploaded files land in the same `BlockStore` the daemon seeds.
