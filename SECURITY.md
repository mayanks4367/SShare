# SShare Security

Threat model, trust boundaries, what is (and is not) protected, and the
concrete mechanisms in place. Read this before deploying or changing any
network-facing code.

## 1. Threat model

| Threat | Adversary capability | Verdict |
|---|---|---|
| Malicious peer | Joins your room, sends hostile SDP/ICE/metadata/chunks/frames | **Contained**: strict validation, per-chunk caps, checksum-gated completion; worst case is a failed transfer, never silent corruption |
| Guessing transfer IDs / room codes | Online enumeration of `SS-XXXXXX` | **Accepted risk, mitigated**: 30-bit entropy + 30-min TTL + per-IP join throttle (§4); a code is a capability, not a secret |
| Unauthorized room joining | Attacker learns a live code (shoulder-surf, leak) | **By design**: possession of the code *is* authorization; rooms are private (unlisted), max 8 peers, `ROOM_FULL` enforced |
| Malicious signaling messages | Oversized/invalid/forged frames over WS | **Contained**: schema validation, 128 KiB cap, binary rejected, room-membership checks on every relay |
| File corruption (accidental or malicious) | Bit flips, truncated/tampered chunks | **Detected, never accepted**: BLAKE3 (native) + SHA-256 (bridge) per chunk and whole file; mismatch fails the transfer |
| Malicious file metadata | Giant `totalChunks` (OOM), huge `fileSize`, hostile names | **Contained**: `assertIncomingMetadata` bounds before any allocation; names length-capped and header-sanitized |
| Oversized transfer requests | 512 MiB+ uploads, giant SDP, frame floods | **Bounded**: 512 MiB upload cap, 64 KiB SDP cap, 2 MiB frame cap, 1 M chunk cap |
| Denial of service | Room floods, connection floods, slowloris-ish use | **Bounded**: room cap (10 k), per-socket + per-IP limiters, heartbeats, TTL sweeps |
| Signaling server abuse | Using rooms/TURN endpoint as free infrastructure | **Rate-limited**: per-IP create/join/TURN limits; TURN creds short-lived |
| TURN credential abuse | Stolen grant used for arbitrary relaying | **Time-boxed**: ≤24 h TTL (default 1 h), HMAC-bound, per-IP issuance limit |
| Browser restrictions bypass | XSS, malicious download names, mixed content | **Contained**: React-escaped rendering, no `eval`/`innerHTML` on user data, `download`-attributed blob URLs of *verified* bytes only |

Out of scope (documented, not protected): endpoint compromise (if an
attackers owns your browser/OS, no app-level mechanism helps), traffic
analysis (sizes/timing visible to network observers), and availability of
public STUN servers.

## 2. What protects what — do not confuse these

| Mechanism | Protects | Does NOT protect |
|---|---|---|
| **WebRTC transport encryption** (DTLS-SCTP, mandatory) | File bytes + control frames on the wire against passive eavesdroppers, on direct *and* TURN-relayed paths | Against the TURN operator seeing *ciphertext sizes/timing*; against a malicious peer (they are a legitimate endpoint) |
| **libp2p Noise** (native transport) | Same transport guarantees for CLI↔CLI traffic | Same limits as above |
| **Application-level encryption** (ChaCha20-Poly1305, `--passphrase`, Rust side only) | File *content* from everyone except passphrase holders — including relay operators and DHT onlookers | Metadata (names, sizes, hashes); weak passphrases (demo-grade KDF, see §7) |
| **File integrity** (BLAKE3 canonical + SHA-256 bridge) | Detects *any* corruption/tampering: every chunk verified, whole file re-hashed before completion | Confidentiality (hashes are not encryption); a malicious peer can still *withhold* data (availability) |
| **Authentication** | Almost none by design: room code possession (capability), TURN HMAC (server-side secret), libp2p peer IDs (self-asserted) | There are no user accounts, no sender identity verification — a peer that holds your code is trusted *as a peer*, and every byte they send is still verified |

Key consequence: **integrity does not imply authenticity of origin** — a
completed transfer proves *these exact bytes*, not *who sent them*. Share
codes only over channels you trust as much as the files themselves.

## 3. Review log (per area)

1. **Signaling authentication** — none (capability model). Documented as
   intentional; rooms unlisted, TTL'd, size-capped.
2. **Session token entropy** — room/transfer ids: 6 chars × 32-symbol
   alphabet = **30 bits**. At the 120/min/IP join cap, an attacker covers
   ~2¹² of 2³⁰ ids per 30-min room lifetime. Acceptable for casual sharing;
   do not use room codes as the *only* protection for highly sensitive files
   (use `--passphrase` encryption, Rust side).
3. **Session expiration** — rooms 30-min TTL + sweep; TURN grants ≤24 h;
   WS heartbeats drop dead sockets with `PEER_LEFT`. Tested.
4. **Room isolation** — every relay checks membership (`NOT_IN_ROOM`
   otherwise); broadcasts exclude the sender; JOINED lists only same-room
   peers. Tested.
5. **WebSocket validation** — schema + size + forbidden-key checks; binary
   frames rejected; unknown types error. Tested.
6. **Rate limiting** — per-socket bucket (30/5 s) + create window (5/min) +
   per-IP create (30/min) + join (120/min) + TURN issuance (20/min) +
   10 k room cap. Tested.
7. **File metadata validation** — `assertIncomingMetadata` (shape, integer,
   consistency, bounds) runs *before* allocation on every inbound manifest.
   Tested, incl. hostile vectors.
8. **Chunk validation** — index bounds, per-frame 2 MiB cap, per-chunk
   ≤ `chunkSize`, running total ≤ `fileSize`, `have` hints sanitized.
   Tested.
9. **File integrity** — BLAKE3 + SHA-256, per-chunk and whole-file, both
   stacks; completion requires a match. Tested (incl. tamper rejection).
10. **Resource limits** — file ≤ 50 GiB, chunks ≤ 1 M, name ≤ 255 chars,
    upload ≤ 512 MiB, SDP ≤ 64 KiB, WS frame ≤ 128 KiB, rooms ≤ 10 k.
11. **XSS** — React-escaped rendering everywhere; the single
    `dangerouslySetInnerHTML` is static theme CSS (`chart.tsx`), not user
    data; filenames only appear as text or `download` hints. Verified by
    inspection (no test framework for "absence"; grep in CI would be welcome).
12. **CSRF** — not applicable: no cookies, no ambient auth; WS/HTTP calls
    carry no credentials. Optional `ALLOWED_ORIGINS` still offered to stop
    third-party sites from driving the signaling API from visitors' browsers.
13. **CORS** — gateway `*` (LAN-trusted daemon, documented); signaling `*`
    on JSON endpoints (no credentials involved).
14. **CSP** — not set by the app (TanStack Start SSR makes a meta-tag CSP
    misleading); deploy behind headers, e.g.
    `default-src 'self'; connect-src 'self' ws: wss: http: https:;
    img-src 'self' blob: data:;` — tune `connect-src` to your signaling,
    gateway and STUN/TURN hosts.
15. **Dependencies** — `npm audit` (prod): 0 vulnerabilities in
    `sshareweb/frontend` and `signaling/` at review time. Rust: run
    `cargo audit`/`cargo deny` in CI (not installed in this environment).
16. **Secret management** — `TURN_SECRET`/`TURN_URLS`/`TURN_TTL_SEC` via
    environment only; grants minted server-side with 1 h default TTL; repo
    grep shows no secrets outside test fixtures and docs placeholders.

## 4. Fixed during this review

| # | Issue | Severity | Fix | Test |
|---|---|---|---|---|
| 1 | Unvalidated inbound `meta` → receiver allocated attacker-sized chunk table (OOM) | High | `assertIncomingMetadata` before allocation (both TS engines) | `peer-security.test.ts`, `resume.test.ts` |
| 2 | `done`/`cancel`/`error` not bound to a transfer → forged `done` finalized bytes early | Medium | transferId must match the active transfer (or message ignored) | same suites |
| 3 | Gateway `:file_id` reached `manifests/<id>.json` unsanitized (traversal-shaped input) | Medium | `valid_file_id` allowlist on all id-taking routes | `file_id_guard…`, traversal wire test |
| 4 | Upload `name` with `"`/controls → `Content-Disposition` header breakage (panic risk via `unwrap`) | Medium | Upload rejects quotes/controls/overlong; `attachment_filename` sanitizes on serve | upload + unit tests |
| 5 | Unbounded room map (memory DoS via room spam) | Medium | `maxRooms` cap (10 k) → `RATE_LIMITED` | cap test |
| 6 | No per-IP WS limits (multi-socket floods/enumeration) | Medium | per-IP create/join limiters | throttle test |
| 7 | Any website could drive signaling from visitors' browsers | Low | Optional `ALLOWED_ORIGINS` (default open + warning) | allow/reject/no-origin tests |
| 8 | No per-chunk size/total caps on DataChannel frames | Low | 2 MiB frame cap, chunkSize/total guards | frame/overrun tests |

Deliberately **not** implemented (would be misleading): E2E-encryption
claims for the browser path (no passphrase E2E there — DTLS + integrity is
what exists), CAPTCHAs, IP bans, request signing without a key story.

## 5. Deployment checklist

- [ ] Run signaling behind TLS (`wss://`); set `ALLOWED_ORIGINS` to your app origin.
- [ ] Set a strong `TURN_SECRET` (≥32 random bytes); serve TURN over TLS where possible.
- [ ] Bind the Rust gateway to loopback unless your LAN is trusted; never expose it publicly as-is (no auth by design).
- [ ] Serve the frontend with the CSP above (tuned) + `Cross-Origin-Opener-Policy` defaults.
- [ ] Run `npm audit` and `cargo audit` in CI; pin/replace on advisories.
- [ ] For sensitive files shared natively, use `--passphrase` (and plan the Argon2id upgrade noted in the roadmap).

## 6. Reporting

Found a vulnerability? Please open a private report with: component +
version/commit, reproduction steps, impact assessment, and (if any) a
suggested fix. Do not file public issues for unpatched high-severity bugs.

Related docs: `WEB_INTEGRATION.md` (boundaries), `WEBRTC_PRODUCTION.md`
(NAT/TURN/real-network matrix), `signaling/PROTOCOL.md` (wire rules),
`PROTOCOL.md` (Rust wire, incl. the documented demo-KDF tradeoff).
