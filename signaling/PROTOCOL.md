# SShare Signaling Protocol v1

Language-agnostic spec. Any client (web, Rust, Android, iOS, desktop) that
speaks this over WebSocket interoperates. The canonical rules live in
`src/protocol.ts` (`validateClientMessage`); port them 1:1.

## Transport

- `ws://host:8787/ws` (or `wss://` in production). One JSON object per
  **text** WebSocket frame. Binary frames are rejected with `ERROR`.
- Max frame: **128 KiB**. Larger frames get `PAYLOAD_TOO_LARGE`.
- Server heartbeat: `ping` every 30 s; dead sockets are dropped and their
  peers receive `PEER_LEFT { reason: "timeout" }`.
- Health: `GET /healthz` → `{ ok, rooms, peers, uptimeSec }`.

## Rooms (private, short-lived)

- `CREATE_ROOM { maxPeers?, ttlSec? }` → `ROOM_CREATED { room, expiresAt, maxPeers }`.
  Server mints the room id (`SS-XXXXXX`, `[A-Z0-9-]{3,32}`); ids are
  unguessable enough for private sharing links, never listed publicly.
- `JOIN_ROOM { room, role: "sender"|"receiver" }` →
  `JOINED { room, clientId, peers: [{clientId, role}], expiresAt }` to the
  joiner, plus `PEER_JOINED { room, peer }` to existing members.
- Default `maxPeers: 2`, allowed `2..8`. Default TTL **30 min**
  (`ttlSec` allowed `60..14400`). Empty rooms are deleted immediately;
  inactive rooms are swept every 30 s. There is no room listing API.
- `LEAVE { room }` → `LEFT { room }` to leaver, `PEER_LEFT { room, peer, reason }`
  to the rest. Abrupt disconnects also broadcast `PEER_LEFT { reason: "disconnect" }`.

## Signaling relay (peer-to-peer SDP/ICE only)

Sender and receiver must both be in the same room; otherwise `NOT_IN_ROOM`.

| Client sends | Server broadcasts (to other room peers) |
|---|---|
| `OFFER { room, sdp }` | `OFFER { room, from, sdp }` |
| `ANSWER { room, sdp }` | `ANSWER { room, from, sdp }` |
| `ICE_CANDIDATE { room, candidate }` | `ICE_CANDIDATE { room, from, candidate }` |

- `sdp = { type: "offer"|"answer", sdp: "v=...\r\n..." }`, SDP string
  `32..65536` chars, must start with `v=`.
- `candidate = { candidate: string, sdpMid?, sdpMLineIndex? }`,
  `candidate` non-empty, `<= 4096` chars.
- Trickle ICE is supported (send candidates as gathered); non-trickle
  (full SDP with candidates) also works since the SDP size cap is generous.

## Transfer-state announcements (headers only)

- `TRANSFER_READY { room, transferId?, fileName?, fileSize?, chunks? }` →
  broadcast with added `from`. Sent by the sender when chunks start flowing
  over the WebRTC DataChannel.
- `TRANSFER_COMPLETE { room, transferId? }` → broadcast with `from`.
- `fileName` 1..255 chars, `fileSize` 0..50 GiB, `chunks` int 1..1e6.
- **File bytes are forbidden.** Any key in
  `{data, chunk, chunks_blob, blob, bytes, payload, fileData, buffer}`
  anywhere in a client message → `VALIDATION_ERROR` and the message is
  dropped. The server has no file storage and no proxy path by construction.

## Presence / connection state (what the server tracks)

The server tracks **transport presence**, not WebRTC internals:

- `WELCOME { clientId }` — first frame on every new socket.
- `PEER_JOINED / PEER_LEFT` — who is in your room right now.
- `TRANSFER_READY / TRANSFER_COMPLETE` — transfer-level progress markers.
- WebRTC states (`connecting/connected/failed`) stay client-side in the
  transfer engine; map `PEER_LEFT` → remote-gone there.

## Errors

`ERROR { code, message, requestId? }` (`requestId` echoes `CREATE_ROOM` /
`JOIN_ROOM` correlation ids). Codes:

`INVALID_JSON | UNKNOWN_TYPE | VALIDATION_ERROR | ROOM_NOT_FOUND |
ROOM_EXPIRED | ROOM_FULL | NOT_IN_ROOM | RATE_LIMITED | PAYLOAD_TOO_LARGE`

## Rate limiting

- Per socket token bucket: burst **30**, refill **5/s** across all types.
- Room creation: **5/min** per socket (stricter window).
- Over limit → `ERROR { code: "RATE_LIMITED" }`, message dropped.

## Minimal flows

**Create + join (2 peers):**
```
A -> CREATE_ROOM {}                    S -> ROOM_CREATED {room:"SS-ABC123",...}
A -> JOIN_ROOM {room, role:"sender"}    S -> JOINED {peers:[]} (to A)
B -> JOIN_ROOM {room, role:"receiver"}  S -> JOINED {peers:[{A,sender}]} (to B)
                                       S -> PEER_JOINED {peer:{B,receiver}} (to A)
A -> OFFER {room,sdp}                   S -> OFFER {room,from:A,sdp} (to B)
B -> ANSWER {room,sdp}                  S -> ANSWER {room,from:B,sdp} (to A)
A <-> ICE_CANDIDATE ...                 S -> relays each
A -> TRANSFER_READY {room,...meta}      S -> TRANSFER_READY {room,from:A,...} (to B)
  ... file bytes flow over WebRTC DataChannel, never here ...
A -> TRANSFER_COMPLETE {room,...}       S -> TRANSFER_COMPLETE {...} (to B)
```

## Porting checklist (Rust / Kotlin / Swift / desktop)

1. JSON text frames, `type` field exactly as above (UPPER_SNAKE).
2. Enforce the same limits before sending (SDP/candidate sizes, no file keys).
3. Handle `WELCOME` → store `clientId`; correlate `requestId` on create/join.
4. Expect out-of-order `PEER_JOINED` vs `JOINED` peers list — merge by `clientId`.
5. Reconnect with backoff; re-`JOIN_ROOM` (server state is ephemeral).
6. Treat `PEER_LEFT` / socket close as remote-gone in the transfer engine.
