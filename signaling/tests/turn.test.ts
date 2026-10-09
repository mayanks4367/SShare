import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  TurnIpLimiter,
  clampTurnTtl,
  mintTurnCredentials,
  verifyTurnCredentials,
} from "../src/turn.js";
import { createSignalingServer, type SignalingServer } from "../src/server.js";

let servers: SignalingServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close().catch(() => {})));
  servers = [];
});

describe("TURN credentials", () => {
  it("mints coturn-compatible username/password", () => {
    const secret = "s3cr3t";
    const creds = mintTurnCredentials(secret, { urls: ["turn:x:3478"] }, 1700000000);
    const [expiry] = creds.username.split(":");
    expect(Number(expiry)).toBe(1700000000 + 3600);
    // Independent recomputation, the way coturn would verify.
    const expectPw = createHmac("sha1", secret).update(creds.username).digest("base64");
    expect(creds.password).toBe(expectPw);
    expect(verifyTurnCredentials(secret, creds, 1700000000)).toBe(true);
    expect(verifyTurnCredentials("wrong", creds, 1700000000)).toBe(false);
    expect(verifyTurnCredentials(secret, creds, 1700000000 + 3601)).toBe(false);
  });

  it("clamps TTLs", () => {
    expect(clampTurnTtl(undefined)).toBe(3600);
    expect(clampTurnTtl(10)).toBe(300);
    expect(clampTurnTtl(1e9)).toBe(86400);
  });

  it("rate-limits per IP", () => {
    let t = 0;
    const l = new TurnIpLimiter(2, 1000, () => t);
    expect(l.tryConsume("1.1.1.1")).toBe(true);
    expect(l.tryConsume("1.1.1.1")).toBe(true);
    expect(l.tryConsume("1.1.1.1")).toBe(false);
    expect(l.tryConsume("2.2.2.2")).toBe(true);
    t += 1001;
    expect(l.tryConsume("1.1.1.1")).toBe(true);
  });
});

describe("POST /api/turn-creds", () => {
  it("issues short-lived credentials when configured", async () => {
    const s = await createSignalingServer({
      port: 0,
      turnSecret: "test-secret",
      turnUrls: ["turn:turn.example.com:3478?transport=udp"],
      turnTtlSec: 600,
    });
    servers.push(s);
    const res = await fetch(`http://127.0.0.1:${s.port}/api/turn-creds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.urls).toEqual(["turn:turn.example.com:3478?transport=udp"]);
    expect(body.ttl).toBe(600);
    const [expiry] = String(body.username).split(":");
    const now = Math.floor(Date.now() / 1000);
    expect(Number(expiry) - now).toBeGreaterThan(590);
    expect(Number(expiry) - now).toBeLessThanOrEqual(600);
    const expectPw = createHmac("sha1", "test-secret").update(String(body.username)).digest("base64");
    expect(body.password).toBe(expectPw);
  });

  it("503s when TURN is not configured (no secret in source)", async () => {
    const s = await createSignalingServer({ port: 0 });
    servers.push(s);
    const res = await fetch(`http://127.0.0.1:${s.port}/api/turn-creds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(503);
  });
});
