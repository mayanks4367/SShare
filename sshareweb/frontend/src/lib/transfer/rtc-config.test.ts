import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyRoute,
  defaultRtcNetConfig,
  fetchTurnGrant,
  withTurnServers,
  wsToHttpBase,
} from "@/lib/transfer/rtc-config";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rtc-config", () => {
  it("defaults to dual STUN with sane timeouts", () => {
    const c = defaultRtcNetConfig();
    expect(c.iceServers.length).toBeGreaterThanOrEqual(1);
    expect(c.connectionTimeoutMs).toBeGreaterThan(0);
    expect(c.backpressureBytes).toBeGreaterThan(0);
    expect(c.resumeWaitMs).toBeGreaterThan(0);
  });

  it("derives HTTP(S) base from WS(S) signaling urls", () => {
    expect(wsToHttpBase("ws://localhost:8787/ws")).toBe("http://localhost:8787");
    expect(wsToHttpBase("wss://sig.example.com/ws/")).toBe("https://sig.example.com");
    expect(wsToHttpBase("wss://sig.example.com:443/custom")).toBe(
      "https://sig.example.com:443/custom",
    );
  });

  it("prepends TURN grants without mutating the base config", () => {
    const base = defaultRtcNetConfig();
    const grant = { urls: ["turn:x:3478"], username: "u", password: "p", ttl: 60 };
    const withTurn = withTurnServers(base, grant);
    expect(withTurn.iceServers[0]).toMatchObject({ username: "u", credential: "p" });
    expect(base.iceServers.length).toBe(defaultRtcNetConfig().iceServers.length);
    expect(withTurnServers(base, null)).toBe(base);
  });

  it("classifies routes without touching addresses", () => {
    expect(classifyRoute(null)).toBe("unknown");
    expect(classifyRoute({ localType: "host", remoteType: "host" })).toBe("direct");
    expect(classifyRoute({ localType: "host", remoteType: "srflx" })).toBe("direct");
    expect(classifyRoute({ localType: "host", remoteType: "relay" })).toBe("relay");
    expect(classifyRoute({ localType: "relay", remoteType: "host" })).toBe("relay");
    expect(classifyRoute({ localType: "weird", remoteType: "odd" })).toBe("unknown");
  });

  it("fetches TURN grants best-effort (null on 503/offline)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("no-turn")) return new Response("{}", { status: 503 });
        return Response.json({ ok: true, urls: ["turn:x"], username: "u", password: "p", ttl: 60 });
      }),
    );
    await expect(fetchTurnGrant("http://no-turn")).resolves.toBeNull();
    await expect(fetchTurnGrant("http://has-turn")).resolves.toMatchObject({ username: "u" });
  });
});
