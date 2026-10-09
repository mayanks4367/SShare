# WebRTC Production Guide (SShare)

How NAT traversal, timeouts, reconnection, resumption and diagnostics work —
and, honestly, where direct P2P stops working.

## 0. Honest limits (read first)

**Direct peer-to-peer is NOT guaranteed in every network.** It depends on both
peers' NATs/firewalls, which the app cannot control:

| Situation | Expected outcome |
|---|---|
| Same LAN / same Wi-Fi | Direct (`host` candidates), fastest |
| Full-cone / restricted-cone NATs, different networks | Usually direct (`srflx` via STUN) |
| Symmetric NAT on either side, or UDP-blocking firewall | Direct fails → **TURN relay required** |
| No TURN configured + symmetric NAT | Transfer **cannot connect** (timeout error, retry offered) |
| Airplane mode / Wi-Fi drop mid-transfer | Interruption → ICE restart, else Retry |
| Relay via TURN | Works, encrypted (DTLS), but slower and metered |

The UI never claims more than it knows: it shows *Connecting…*, *Direct P2P*,
*Relayed via TURN*, or *Connection failed* based on the live selected ICE
pair — never an assumed state.

## 1. Architecture

```
Browser A ◄── DataChannel (DTLS-SCTP, chunks) ──► Browser B   (file bytes)
    │  SDP/ICE over WSS rooms                         │
    └─────────────► signaling/ ◄──────────────────────┘
                          │
              POST /api/turn-creds (short-lived TURN grant)
```

File bytes travel **only** the DataChannel (primary) or the explicit gateway
fallback. Signaling and TURN see headers/ciphertext, never file content.

## 2. STUN / TURN configuration

**Client** (`sshareweb/frontend`, `src/lib/transfer/rtc-config.ts`):

- Default STUN: `stun:stun.l.google.com:19302` + `stun:stun1.l.google.com:19302`
  (override: `VITE_STUN_URLS`, comma-separated).
- At session start the app `POST`s the signaling HTTP base
  (`/api/turn-creds`, 5 s timeout, best-effort). A grant is prepended to
  `iceServers`; on 503/offline/timeout the app proceeds **STUN-only**.
- ICE does the rest automatically: host → srflx → **relay fallback** when a
  grant exists. No manual relay toggle.

**Server** (`signaling/`, `src/turn.ts` + `POST /api/turn-creds`):

- `TURN_SECRET` (required to enable), `TURN_URLS` (comma-separated,
  e.g. `turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349`),
  `TURN_TTL_SEC` (default 3600, clamped 300–86400).
- Credentials are coturn `use-auth-secret` style: username
  `<expiry-unix>:<random>`, password `base64(HMAC-SHA1(secret, username))`.
  The secret never leaves the server and **nothing TURN-related is in the
  frontend source** (only URLs in `.env.example`, no secrets).
- Endpoint is per-IP rate-limited (20/min) with CORS `*`. `/healthz` reports
  `turn: { urls, ttlSec } | null` so clients know what to expect.

**coturn example** (`/etc/turnserver.conf`):

```text
listening-port=3478
tls-listening-port=5349
realm=share.example.com
use-auth-secret
static-auth-secret=PUT_THE_SAME_VALUE_IN_TURN_SECRET
total-quota=100
bps-capacity=0
log-file=/var/log/turn.log
```

Run signaling with `TURN_SECRET=<same> TURN_URLS="turn:share.example.com:3478?transport=udp"`.

## 3. Timeouts & tuning

| Knob | Default | Meaning |
|---|---|---|
| `VITE_RTC_CONNECTION_TIMEOUT_MS` | 25000 | Give up establishment → timeout error + Retry |
| `VITE_RTC_GATHERING_TIMEOUT_MS` | 8000 | Manual (non-trickle) SDP gathering cap |
| `VITE_RTC_BACKPRESSURE_BYTES` | 1048576 | DataChannel `bufferedAmount` pause threshold |
| `VITE_RTC_RESUME_WAIT_MS` | 1500 | Sender waits this long for a receiver `have` hint |
| `VITE_RTC_STATS_POLL_MS` | 3000 | Route-diagnostics poll (0 = off) |
| TURN grant fetch | 5000 (fixed) | Best-effort; never blocks direct attempts |
| TURN credential TTL | 3600 (server) | Short-lived by design |
| Backpressure stall escape | 30000 (fixed) | Never hang forever on a dead channel |

`TransferPeer` takes the same values as constructor `PeerOptions`, so
non-React clients get identical behavior.

## 4. Connection lifecycle & diagnostics

1. `new` → signaling handshake (offer/answer + trickle ICE).
2. `connecting` → timeout armed. No `connected` in budget → timeout error.
3. `connected` → timeout cleared, route polling classifies the pair:
   **direct** (`host`/`srflx`) or **relay** (`relay` = TURN).
4. `disconnected` (transient) → sender ICE-restarts (≤2 attempts, 5 s grace);
   receiver re-answers automatically. DataChannel often survives.
5. `failed`/timeout/peer-left → failed card with **Try again** (full rejoin).
6. Route changes mid-transfer update the badge live.

**Privacy-conscious:** diagnostics expose only the route *kind* (+ RTT).
Candidate IPs are read from `getStats` locally, classified, and discarded —
never displayed, logged, or sent to any server.

## 5. Interruption, cancellation, resumption

- **Backpressure**: sender pauses above the threshold (`bufferedAmountLow`
  + 50 ms poll + 30 s escape); stalls are counted (`peer.backpressureStalls`).
- **Cancellation**: either side cancels anytime; a `cancel` frame is sent
  best-effort and both sides land in `cancelled`. Cancel also aborts a paused
  loop and any gateway fetch.
- **Pause/resume** (P2P): sender-side gating; the receiver just sees a stall.
- **Resumption** (`have` hints, same session): after `meta`, the sender waits
  up to `resumeWaitMs` for `{t:"have"}`; a receiver that already holds chunks
  of that `transferId` replies with its index list and the sender skips them
  (progress starts pre-credited). Hints are sanitized; a hostile/lying hint
  can only produce a checksum failure, never silent corruption.
- **Retry** (new session): restarts the queue from the beginning — the honest
  fallback when the DataChannel itself is gone. Gateway fallback has no
  resume (documented; HTTP Range support is future work).

## 6. What is tested automatically

- signaling: HMAC mint/verify vectors, TTL clamp, per-IP limiter,
  live `POST /api/turn-creds` (grant shape + expiry + 503-without-secret).
- frontend: STUN/TURN config builders, `wsToHttpBase`, `classifyRoute`,
  `fetchTurnGrant` null-on-503, `sanitizeHave`/`computeRemaining`,
  `have` round-trip, signaling client routing, chunking/checksum suites.
- Rust + gateway suites unchanged and passing.

## 7. What requires real networks (checklist)

Automated tests cannot fake NATs. Verify manually before calling it done:

- [ ] Two laptops, same Wi-Fi → badge shows **Direct P2P**, transfer completes.
- [ ] Phone hotspot vs home Wi-Fi → direct or relay; completes.
- [ ] Symmetric NAT (e.g. phone carrier data both sides) **with TURN** → badge
      shows **Relayed via TURN**, completes (slower).
- [ ] Same symmetric-NAT setup **without TURN** → clean timeout error
      (~25 s) + working Try again (do NOT ship claiming otherwise).
- [ ] Airplane-mode toggle mid-transfer → ICE restart recovers **or** clear
      failure + retry; no stuck progress bar.
- [ ] Kill the sender tab mid-transfer → receiver sees peer-left/failed.
- [ ] `POST /api/turn-creds` returns distinct passwords per call; an old
      credential past expiry is rejected by coturn.
- [ ] Throttled CPU/network (devtools) → backpressure engages, no OOM,
      progress stays monotonic.
