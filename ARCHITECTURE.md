# SwarmShare Architecture

```
sender/                          # repo root (this project)
├── Cargo.toml                   # virtual workspace
├── README.md / PROTOCOL.md / ARCHITECTURE.md
├── scripts/local-2peer.sh
└── crates/
    ├── swarmshare-core/         # no network, no tokio — pure logic, fully tested
    │   └── src/
    │       ├── lib.rs
    │       ├── chunk.rs         # Chunker (256 KiB, zstd opt), BLAKE3, file_id
    │       ├── manifest.rs      # FileManifest + DHT key helpers + verify
    │       ├── store.rs         # BlockStore: blocks/ manifests/ downloads/ files/
    │       ├── picker.rs        # RarestFirstPicker, PeerReputation, ChokeManager
    │       ├── parity.rs        # XOR parity build/repair
    │       └── crypto.rs        # ChaCha20-Poly1305 chunk encrypt, passphrase KDF
    ├── swarmshare-net/          # libp2p only
    │   └── src/
    │       ├── lib.rs           # re-exports
    │       ├── behaviour.rs     # SwarmBehaviour: kad+gossipsub+mdns+identify+2×rpc
    │       ├── protocol.rs      # Chunk{Request,Response}, Manifest{Request,Response}
    │       └── node.rs          # Node event loop + Client handle (channels)
    └── swarmshare-cli/          # binary `swarmshare`
        └── src/
            ├── main.rs          # share/download/search/daemon/status/demo
            └── gateway.rs       # axum dashboard + /file + /api + /metrics
```

## Data flow

### Share
`import_file` (chunk→store→manifest[+parity][+encrypt]) → `spawn_node`
(listen TCP+QUIC, bootstrap dials) → `start_providing` → `put_record`
manifest + index → gossip `publish` → serve forever (net layer auto-serves
hits from `BlockStore`; app replies `not-found` respecting choke).

### Download
dial/`get_providers` → `ManifestRpc` → DHT record fallback → resume bitfield →
rarest-first order → semaphore(N) parallel `ChunkRpc` with reputation-ranked
failover → verify → store → retry → assemble → `start_providing` (seed).

### Why this split?

- **core** stays dependency-light and testable offline (`cargo test` needs no
  sockets). The viva `demo` exercises core only.
- **net** isolates all libp2p version churn (builder API, behaviour derives)
  behind a small `Client`/`NodeEvent` channel API.
- **cli** owns policy (parallelism, timeouts, retries, UX) so transport upgrades
  don't rewrite download logic.

## Key decisions

- Fixed 256 KiB chunks: fits libp2p request-response comfortably, enough pieces
  for parallelism on 100 MB+ files, small enough for DHT-era RAM.
- CBOR RPC codec: schema-free, serde-native, smaller than JSON on the wire.
- Custom Kademlia protocol `/swarmshare/kad/1.0.0`: avoids colliding with IPFS
  bootstrap nodes if a user adds them.
- `MemoryStore` (not persistent): manifests/blocks already persist on disk;
  DHT republish on daemon start re-heals routing.
- Single-threaded swarm event loop + channel `Client`: the standard rust-libp2p
  pattern; avoids `Swarm` `Send` pitfalls across tasks.
