/**
 * Package entry: server + protocol + rooms + client.
 * NOTE: `server.ts` never imports `client.ts` — the file-transfer layer
 * and the signaling transport stay decoupled.
 */
export * from "./protocol.js";
export * from "./rooms.js";
export * from "./rateLimiter.js";
export * from "./turn.js";
export { createSignalingServer, type SignalingOptions, type SignalingServer } from "./server.js";
export { SignalingClient, type SignalingEvents } from "./client.js";

import { createSignalingServer } from "./server.js";

// Run as a service: `node dist/index.js` (PORT env, default 8787).
const isMain = process.argv[1]?.endsWith("/index.js") || process.argv[1]?.endsWith("\\index.js");
if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  createSignalingServer({ port })
    .then((s) => {
      console.log(`ssshare-signaling listening on :${s.port} (health: /healthz)`);
    })
    .catch((e) => {
      console.error("failed to start signaling server:", e);
      process.exit(1);
    });
}
