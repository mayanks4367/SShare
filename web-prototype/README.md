# SShare WebRTC Prototype (minimal, no server)

Modular TypeScript prototype for peer-to-peer file transfer over a reliable
WebRTC DataChannel. **Does not touch the existing Rust project** (`crates/*`
unchanged) and does not integrate with the Rust transfer engine yet — the
`transfer-engine/` is deliberately shaped so SShare chunking/hashing can later
replace the TS implementations behind the same interfaces.

## Run

```bash
cd web-prototype
npm install
npm test          # unit tests (chunking, ordering, reconstruction, metadata, checksum)
npm run dev       # http://localhost:5173 — open on two browsers/devices
npm run build     # typecheck + production build
```

## Use (30 seconds, no signaling server)

Manual copy-paste signaling (non-trickle ICE, one paste per direction):

1. **A:** `Create session` → select file → copy **offer** → send to B.
2. **B:** paste offer → `Join + make answer` → copy **answer** → send to A.
3. **A:** paste answer → `Connect` → `Send file`.
4. **B:** watches progress → checksum verified → `Download received file`.

Works on same machine (two tabs), LAN, and across NAT via public STUN.
No file bytes touch any server — there is no server.

## Layout

```
web-prototype/
  index.html
  src/transfer-engine/  chunker.ts checksum.ts protocol.ts peer.ts types.ts index.ts
  src/signaling/manual.ts  (encode/decode SDP, offer/answer helpers, SignalingChannel iface)
  src/app/main.ts styles.css
  tests/  chunker|reconstruction|metadata|checksum.test.ts
```

## Limits (by design for minimality)

- One file per session, one sender → one receiver.
- No TURN (STUN only); symmetric-NAT pairs may fail — add coturn later.
- No pause/resume across reloads (in-memory receiver); cancel supported mid-flight.
- Whole-file SHA-256 verified at end; per-chunk BLAKE3 comes with SShare integration.
