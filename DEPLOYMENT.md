# SShare Deployment Guide

How to run SShare for real users. Local `npm run dev` commands are a
developer workflow — production users should never start servers by hand.

## Topology

```
                                    HTTPS (static hosting / CDN)
                                   ┌─────────────────────┐
phones/laptops ──HTTPS───────────► │  frontend build     │
                                   └─────────────────────┘
                                    WSS /api/turn-creds (same or second origin)
                                   ┌─────────────────────┐
             ──WSS/HTTPS─────────► │  TLS reverse proxy  │──► signaling :8787 (loopback)
                                   └─────────────────────┘
File bytes: browser ◄──WebRTC DataChannel──► browser (never via servers).
Optional deliberate fallback only: browser ──HTTPS──► Rust gateway :8080.
```

## Environment matrix

| Variable | Local dev | Same-Wi-Fi (laptop ↔ phone) | Production |
|---|---|---|---|
| Frontend served from | `vite dev :5173` | dev server with `--host`, phone opens `http://<lan-ip>:5173` | static host / CDN over HTTPS |
| `VITE_SIGNALING_URL` | `ws://localhost:8787/ws` | `ws://<lan-ip>:8787/ws` | `wss://signal.example.com/ws` |
| `VITE_SSHARE_API_URL` | `http://localhost:8080` | `http://<lan-ip>:8080` (only for gateway fallback) | `https://gateway.example.com` (only if fallback wanted) |
| `VITE_RECEIVER_BASE_URL` | unset (page origin) | `http://<lan-ip>:5173` **or** the in-app LAN-host override (§LAN) | `https://share.example.com` |
| Signaling bind | `PORT=8787` loopback or LAN | LAN-reachable host, `ALLOWED_ORIGINS=http://<lan-ip>:5173` | loopback behind TLS proxy, `ALLOWED_ORIGINS=https://share.example.com` |
| `TURN_SECRET`/`TURN_URLS` | unset (direct LAN works) | usually unset | **set** (carrier NATs need relay) |

The app detects `https` page + `ws://`/`http://` endpoints and shows a
configuration warning instead of failing silently (see `config.ts`).

## TLS reverse proxy (production)

Caddy (automatic certificates):

```text
share.example.com {
    root * /srv/sshare-frontend
    file_server
}
signal.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

nginx equivalent:

```nginx
server {
    listen 443 ssl;
    server_name signal.example.com;
    ssl_certificate /etc/letsencrypt/live/signal.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/signal.example.com/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

Notes: the signaling server needs no code changes for TLS (termination at
the proxy); it reads the client IP from the raw socket, so per-IP rate
limits apply to the proxy address when proxied — put broader flood
protection at the proxy. Keep `ALLOWED_ORIGINS=https://share.example.com`.

## Same-Wi-Fi transfers (no production deploy needed)

1. Both devices join the **same Wi-Fi**. Guest/AP-isolated networks block
   device-to-device traffic — use the main network.
2. On the laptop, start signaling bound to the LAN (`PORT=8787` listens on
   all interfaces by default) and the frontend with `vite dev --host`.
3. The share-link host must be the laptop's LAN address, not `localhost`:
   set `VITE_RECEIVER_BASE_URL=http://<lan-ip>:5173` **or** type the LAN
   address once in the app's *Link host* field (remembered on the device).
   Links containing `localhost` show a warning that phones can't open them.
4. OS firewall must allow inbound TCP on the signaling port (8787) and the
   frontend port (5173); WebRTC then negotiates its own UDP ports
   (direct path) or falls back to TURN if configured.

Limitations, stated plainly: a browser cannot discover the laptop's LAN IP
by itself, cannot open firewall ports, and cannot serve anything — every
LAN step above is either user input or OS/network configuration. No part
of the app exposes arbitrary local services; the only URL ever shared is
the frontend's own receiver page.

## Desktop service manager (separate future integration)

Automatically starting signaling/gateway daemons, picking the LAN address,
and opening the firewall cannot be done from a web page. The honest place
for that is a small desktop companion (e.g. Tauri/Electron tray app) that
owns the local services and deep-links into the web UI. That is a separate
project: it must not be faked with browser code, and this guide does not
pretend otherwise.

## Verification checklist

- [ ] Production build served over HTTPS; `wss://` signaling connects.
- [ ] Mixed-content guard stays silent (no warnings on correct config).
- [ ] Same-Wi-Fi phone transfer completes; QR link opens without typing.
- [ ] Firewall-off vs firewall-on behavior documented for your OS.
- [ ] TURN grant issuance works through the proxy (`POST /api/turn-creds`).
- [ ] `npm audit` / `cargo audit` clean; see `SECURITY.md`.
