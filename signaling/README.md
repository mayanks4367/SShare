# ssshare-signaling

Dedicated WebSocket signaling service for SShare WebRTC file sharing.

- Private, short-lived rooms (`SS-XXXXXX` token = the room id, no listing API).
- Relays SDP offers/answers + ICE candidates between room peers.
- Tracks presence (`PEER_JOINED`/`PEER_LEFT`), announces transfer state
  (`TRANSFER_READY`/`TRANSFER_COMPLETE` headers only).
- Expires inactive rooms (default 30 min TTL, 30 s sweep).
- **Never stores transferred files and never proxies file data** — binary
  frames rejected, file-byte keys rejected by validation, 128 KiB frame cap.
- Validation + per-socket rate limiting (30 burst / 5 s refill, 5 rooms/min).
- No dependency on the file-transfer layer: `src/server.ts` never imports
  `src/client.ts` or anything under `web-prototype/`.

See [PROTOCOL.md](./PROTOCOL.md) for the cross-platform wire spec.

## Run

```bash
cd signaling
npm install
npm test            # unit + live WebSocket integration tests
npm run build       # tsc -> dist/
PORT=8787 npm start # or: node dist/index.js
```

Health: `GET /healthz` → `{ ok, rooms, peers, uptimeSec }`.

## Layout

```
signaling/
  src/
    protocol.ts     # wire types + validateClientMessage + limits (port 1:1)
    rooms.ts        # RoomManager: create/join/leave/expiry (no file data)
    rateLimiter.ts  # token bucket + create-room window
    server.ts       # createSignalingServer() — HTTP health + WS routing
    client.ts       # SignalingClient for browsers/native (server never imports)
    index.ts        # re-exports + runnable service entry
  tests/
    protocol.test.ts rateLimiter.test.ts rooms.test.ts server.test.ts
  PROTOCOL.md README.md
```

## Web app integration

`SignalingClient` (in `src/client.ts`, browser-compatible `WebSocket`) maps
directly onto the manual-signaling flow in
`../web-prototype/src/signaling/manual.ts`: replace the copy-paste step with
`createRoom()` → share `room` code → `join(room)` → `sendOffer/sendAnswer/sendIce()`,
keeping `TransferPeer` untouched.
