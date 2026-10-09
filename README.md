# 🌀 SwarmShare — Decentralized P2P File Sharing Network

**Tech:** Rust · libp2p · Kademlia DHT · Gossipsub · TCP + QUIC (UDP) · BLAKE3
**Type:** BitTorrent-like file distribution, tracker-free, content-addressed.

Peers find each other over a Kademlia DHT + Gossipsub + mDNS, then download
**256 KiB file chunks in parallel** with rarest-first selection, per-peer
reputation, and tit-for-tat fairness.

```
┌──────────┐  DHT provide/get   ┌──────────┐
│  Peer A  │◄──────────────────►│  Peer B  │
│ (seeder) │  Gossipsub announce│ (leecher)│
└────┬─────┘  mDNS (LAN)        └────┬─────┘
     │ ┌──────────────────────────┐  │
     └──►  chunk 0,2,4… (parallel)◄──┘
          verify BLAKE3 → assemble
```

## ✨ What's beyond basic BitTorrent?

| # | Idea (implemented) | Why it's better |
|---|---|---|
| 1 | **BLAKE3 content addressing + Merkle file-id** | Faster than SHA-1, parallel verify, automatic dedup across files |
| 2 | **Rarest-first picker** | Maximises swarm health; rare pieces spread first |
| 3 | **Parallel workers (default 8) + failover** | All providers tried in reputation order, 20s timeouts |
| 4 | **Peer reputation (EWMA 0–1)** | Bad/slow peers deprioritised automatically |
| 5 | **Tit-for-tat choke manager** | N upload slots + optimistic unchoke every 10s (BitTorrent fairness) |
| 6 | **Dual discovery: DHT + Gossipsub + mDNS + Identify** | LAN zero-config + global DHT + live announcements |
| 7 | **DHT keyword search** (`index:<kw>` records) | No central tracker; `search <keyword>` works |
| 8 | **XOR parity blocks** (1 per N chunks) | Recover any 1 lost chunk per group if a seeder vanishes |
| 9 | **Optional zstd compression** (`--compress`) | Smaller wire size for text/logs |
| 10 | **Optional ChaCha20-Poly1305 encryption** (`--passphrase`) | Private swarms; wrong passphrase fails auth |
| 11 | **Resume** (bitfield state) | Kill + restart a download, it continues |
| 12 | **HTTP gateway + dashboard** (`:8080`) | Any browser can browse `/api/files` and fetch `/file/<id>` |
| 13 | **TCP + QUIC transports, Noise encryption, Yamux** | Raw-socket performance + encrypted channels + NAT-friendly UDP |
| 14 | **Offline `demo`** | Full viva demo without any network |

## 🚀 Quick start (2 minutes)

```bash
cargo build -p swarmshare
./target/debug/swarmshare demo --mb 1        # offline: chunking + picker + parity

# Terminal 1 — share (note the file_id + peer id it prints)
./target/debug/swarmshare --data-dir ./data-a share ./Cargo.toml -k demo --port 40010

# Terminal 2 — download via direct peer addr (no DHT bootstrap needed on LAN)
./target/debug/swarmshare --data-dir ./data-b download <FILE_ID> \
  --peer /ip4/127.0.0.1/tcp/40010/p2p/<PEER_ID> --out ./got.toml
diff ./Cargo.toml ./got.toml && echo OK
```

Two-peer script (does the above automatically):

```bash
./scripts/local-2peer.sh
```

## 📖 Commands

```
swarmshare share <FILE> [-k kw...] [--compress] [--parity 4]
           [--passphrase s] [--port 40010] [-b BOOTSTRAP]... [--gateway 127.0.0.1:8080]
swarmshare download <FILE_ID> [--peer ADDR]... [-b BOOTSTRAP]...
           [--parallel 8] [--out PATH] [--passphrase s]
swarmshare search <keyword> [-b BOOTSTRAP]...
swarmshare daemon [--port 40010] [--gateway 127.0.0.1:8080]
swarmshare status
swarmshare demo [--mb 2]
```

Global: `--data-dir <dir>` isolates identity (`key.bin`), blocks, manifests.

### Examples

```bash
# Share with compression + parity + search keywords
swarmshare --data-dir ./a share ./movie.mkv -k movie -k 4k --compress --parity 4 --port 40010

# Private share
swarmshare --data-dir ./a share ./secret.zip --passphrase 'correct horse' --port 40010
swarmshare --data-dir ./b download <ID> --peer <ADDR> --passphrase 'correct horse'

# DHT keyword search (needs ≥2 DHT-bootstrapped peers)
swarmshare --data-dir ./b search movie -b /ip4/1.2.3.4/tcp/40010/p2p/<ID>

# Long-lived seeder + browser dashboard at http://127.0.0.1:8080
swarmshare --data-dir ./a daemon --port 40010 --gateway 127.0.0.1:8080
```

## 🧠 How it works

1. **Chunk:** file → 256 KiB pieces → (zstd?) → (ChaCha?) → BLAKE3 each.
   `file_id = BLAKE3(chunk_hash_0 ‖ chunk_hash_1 ‖ …)`.
2. **Store:** blocks in `<data>/blocks/<hash>`, manifest in `manifests/<id>.json`.
3. **Announce:** `start_providing(file_id)` + `put_record(file:<id>, manifest)` +
   `put_record(index:<kw>, [ids])` + Gossipsub `{"file_id", "file_name", …}`.
4. **Discover:** `get_providers(file_id)` (DHT) or `--peer` direct dial;
   mDNS auto-discovers LAN peers; Identify feeds addrs into Kademlia.
5. **Fetch:** rarest-first order → N parallel `ChunkRequest{hash}` →
   verify BLAKE3 (or Poly1305) → `put_block` → save bitfield → retry →
   parity repair → `assemble()` → re-seed.

See [`PROTOCOL.md`](PROTOCOL.md) for wire keys/record layout, and
[`ARCHITECTURE.md`](ARCHITECTURE.md) for crate map.

## 🗂️ Layout

```
Cargo.toml                    # workspace
crates/swarmshare-core/       # chunk, manifest, store, picker, parity, crypto
crates/swarmshare-net/        # libp2p behaviour (kad+gossipsub+mdns+identify+rpc)
crates/swarmshare-cli/        # CLI + gateway + parallel downloader
scripts/local-2peer.sh        # automated 2-peer test
```

## 🧪 Tests

```bash
cargo test -p swarmshare-core          # 7 unit tests (chunk/parity/crypto/picker)
./target/debug/swarmshare demo --mb 1  # offline end-to-end sim
./scripts/local-2peer.sh               # live localhost transfer + integrity diff
```

## 🛣️ Roadmap (great viva answers)

- Reed–Solomon erasure coding (replace XOR, tune overhead)
- Argon2id KDF (replace demo BLAKE3-KDF) + PSK private networks (libp2p-pnet)
- Relay + DCUtR + AutoNAT for symmetric-NAT traversal
- HAVE/WANT bitfield gossip for true rarest-first across partial peers
- QUIC-only fast path + uTP-style congestion control
- WebTransport gateway so browsers join the swarm directly

## 🔒 Security

Threat model, trust boundaries and deployment checklist: [`SECURITY.md`](SECURITY.md).
Web specifics: [`WEB_INTEGRATION.md`](WEB_INTEGRATION.md) (boundaries),
[`WEBRTC_PRODUCTION.md`](WEBRTC_PRODUCTION.md) (NAT/TURN/limits),
[`signaling/PROTOCOL.md`](signaling/PROTOCOL.md) (wire rules).

## 📚 References

- rust-libp2p `file-sharing` + `ipfs-kad` examples (protocol patterns)
- libp2p specs: Kademlia DHT, Gossipsub, mDNS, Identify, Noise, Yamux, QUIC
- BitTorrent BEPs: rarest-first, choking/optimistic-unchoke, DHT (BEP 5)
