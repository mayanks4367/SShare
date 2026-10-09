import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { createSignalingServer, type SignalingServer } from "../src/server.js";

const SDP = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";

let servers: SignalingServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close().catch(() => {})));
  servers = [];
});

interface TestClient {
  ws: WebSocket;
  inbox: Record<string, unknown>[];
  clientId: string | null;
}

async function openClient(port: number): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const c: TestClient = { ws, inbox: [], clientId: null };
  // Attach BEFORE open: the server sends WELCOME immediately on connect.
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw)) as Record<string, unknown>;
    if (msg.type === "WELCOME") c.clientId = msg.clientId as string;
    else c.inbox.push(msg);
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("connect timeout")), 3000);
    ws.on("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
  // Wait for WELCOME.
  await new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const check = () => {
      if (c.clientId) resolve();
      else if (Date.now() - t0 > 2000) reject(new Error("no WELCOME"));
      else setTimeout(check, 20);
    };
    check();
  });
  return c;
}

/** Wait for first inbox message matching pred (checked against backlog + new). */
function waitFor(c: TestClient, pred: (m: Record<string, unknown>) => boolean, timeoutMs = 3000): Promise<Record<string, unknown>> {
  const found = c.inbox.find(pred);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      c.ws.off("message", onMsg);
      reject(new Error("waitFor timeout"));
    }, timeoutMs);
    const onMsg = (raw: Buffer) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>;
      if (msg.type !== "WELCOME" && pred(msg)) {
        clearTimeout(t);
        c.ws.off("message", onMsg);
        resolve(msg);
      }
    };
    c.ws.on("message", onMsg);
  });
}

function send(c: TestClient, obj: unknown): void {
  c.ws.send(JSON.stringify(obj));
}

describe("signaling server", () => {
  it("creates a room and returns ROOM_CREATED", async () => {
    const s = await createSignalingServer({ port: 0, sweepMs: 50 });
    servers.push(s);
    const a = await openClient(s.port);
    send(a, { type: "CREATE_ROOM", requestId: "r1" });
    const created = await waitFor(a, (m) => m.type === "ROOM_CREATED");
    expect(created.requestId).toBe("r1");
    expect(created.room).toMatch(/^SS-[A-Z2-9]{6}$/);
    expect((created.expiresAt as number)).toBeGreaterThan(Date.now());
    a.ws.close();
  });

  it("joins peers and notifies peer discovery (JOINED + PEER_JOINED)", async () => {
    const s = await createSignalingServer({ port: 0, sweepMs: 50 });
    servers.push(s);
    const a = await openClient(s.port);
    const b = await openClient(s.port);
    send(a, { type: "CREATE_ROOM", requestId: "c" });
    const created = await waitFor(a, (m) => m.type === "ROOM_CREATED");
    const room = created.room as string;

    send(a, { type: "JOIN_ROOM", room, role: "sender", requestId: "j1" });
    const joinedA = await waitFor(a, (m) => m.type === "JOINED");
    expect(joinedA.peers).toEqual([]);
    expect(joinedA.requestId).toBe("j1");

    send(b, { type: "JOIN_ROOM", room, role: "receiver" });
    const joinedB = await waitFor(b, (m) => m.type === "JOINED");
    expect(joinedB.peers).toEqual([{ clientId: a.clientId, role: "sender" }]);

    const noticed = await waitFor(a, (m) => m.type === "PEER_JOINED");
    expect(noticed.peer).toEqual({ clientId: b.clientId, role: "receiver" });
    a.ws.close();
    b.ws.close();
  });

  it("rejects a third peer with ROOM_FULL", async () => {
    const s = await createSignalingServer({ port: 0, sweepMs: 50 });
    servers.push(s);
    const clients = [await openClient(s.port), await openClient(s.port), await openClient(s.port)];
    send(clients[0], { type: "CREATE_ROOM", requestId: "c", maxPeers: 2 });
    const created = await waitFor(clients[0], (m) => m.type === "ROOM_CREATED");
    const room = created.room as string;
    send(clients[0], { type: "JOIN_ROOM", room, role: "sender" });
    await waitFor(clients[0], (m) => m.type === "JOINED");
    send(clients[1], { type: "JOIN_ROOM", room, role: "receiver" });
    await waitFor(clients[1], (m) => m.type === "JOINED");
    send(clients[2], { type: "JOIN_ROOM", room, role: "receiver", requestId: "full" });
    const err = await waitFor(clients[2], (m) => m.type === "ERROR");
    expect(err.code).toBe("ROOM_FULL");
    clients.forEach((c) => c.ws.close());
  });

  it("relays OFFER / ANSWER / ICE_CANDIDATE between peers only", async () => {
    const s = await createSignalingServer({ port: 0, sweepMs: 50 });
    servers.push(s);
    const a = await openClient(s.port);
    const b = await openClient(s.port);
    send(a, { type: "CREATE_ROOM" });
    const created = await waitFor(a, (m) => m.type === "ROOM_CREATED");
    const room = created.room as string;
    send(a, { type: "JOIN_ROOM", room, role: "sender" });
    await waitFor(a, (m) => m.type === "JOINED");
    send(b, { type: "JOIN_ROOM", room, role: "receiver" });
    await waitFor(b, (m) => m.type === "JOINED");

    send(a, { type: "OFFER", room, sdp: { type: "offer", sdp: SDP } });
    const offer = await waitFor(b, (m) => m.type === "OFFER");
    expect(offer.from).toBe(a.clientId);
    expect((offer.sdp as Record<string, string>).type).toBe("offer");
    // Sender must NOT receive its own offer back.
    expect(a.inbox.filter((m) => m.type === "OFFER")).toEqual([]);

    send(b, { type: "ANSWER", room, sdp: { type: "answer", sdp: SDP } });
    const answer = await waitFor(a, (m) => m.type === "ANSWER");
    expect(answer.from).toBe(b.clientId);

    const cand = { candidate: "candidate:1 1 udp 1 1.2.3.4 5000 typ host", sdpMid: "0", sdpMLineIndex: 0 };
    send(a, { type: "ICE_CANDIDATE", room, candidate: cand });
    const ice = await waitFor(b, (m) => m.type === "ICE_CANDIDATE");
    expect(ice.from).toBe(a.clientId);
    expect(ice.candidate).toEqual(cand);
    a.ws.close();
    b.ws.close();
  });

  it("broadcasts TRANSFER_READY / TRANSFER_COMPLETE headers", async () => {
    const s = await createSignalingServer({ port: 0, sweepMs: 50 });
    servers.push(s);
    const a = await openClient(s.port);
    const b = await openClient(s.port);
    send(a, { type: "CREATE_ROOM" });
    const created = await waitFor(a, (m) => m.type === "ROOM_CREATED");
    const room = created.room as string;
    send(a, { type: "JOIN_ROOM", room, role: "sender" });
    await waitFor(a, (m) => m.type === "JOINED");
    send(b, { type: "JOIN_ROOM", room, role: "receiver" });
    await waitFor(b, (m) => m.type === "JOINED");

    send(a, { type: "TRANSFER_READY", room, transferId: "SS-X", fileName: "f.bin", fileSize: 42, chunks: 1 });
    const ready = await waitFor(b, (m) => m.type === "TRANSFER_READY");
    expect(ready.from).toBe(a.clientId);
    expect(ready.fileName).toBe("f.bin");

    send(a, { type: "TRANSFER_COMPLETE", room, transferId: "SS-X" });
    const done = await waitFor(b, (m) => m.type === "TRANSFER_COMPLETE");
    expect(done.from).toBe(a.clientId);
    a.ws.close();
    b.ws.close();
  });

  it("never accepts file bytes: rejects smuggled payloads and binary frames", async () => {
    const s = await createSignalingServer({ port: 0, sweepMs: 50 });
    servers.push(s);
    const a = await openClient(s.port);
    send(a, { type: "CREATE_ROOM" });
    const created = await waitFor(a, (m) => m.type === "ROOM_CREATED");
    const room = created.room as string;

    send(a, { type: "TRANSFER_READY", room, data: "QUJDRA==" });
    const err = await waitFor(a, (m) => m.type === "ERROR");
    expect(err.code).toBe("VALIDATION_ERROR");

    a.ws.send(Buffer.from([0, 1, 2, 3]));
    const err2 = await waitFor(a, (m) => m.type === "ERROR" && /binary/i.test(String(m.message)));
    expect(err2).toBeTruthy();
    a.ws.close();
  });

  it("notifies PEER_LEFT on disconnect and removes the peer", async () => {
    const s = await createSignalingServer({ port: 0, sweepMs: 50 });
    servers.push(s);
    const a = await openClient(s.port);
    const b = await openClient(s.port);
    send(a, { type: "CREATE_ROOM" });
    const created = await waitFor(a, (m) => m.type === "ROOM_CREATED");
    const room = created.room as string;
    send(a, { type: "JOIN_ROOM", room, role: "sender" });
    await waitFor(a, (m) => m.type === "JOINED");
    send(b, { type: "JOIN_ROOM", room, role: "receiver" });
    await waitFor(b, (m) => m.type === "JOINED");
    await waitFor(a, (m) => m.type === "PEER_JOINED");

    b.ws.close();
    const left = await waitFor(a, (m) => m.type === "PEER_LEFT");
    expect(left.peer).toBe(b.clientId);
    expect(s.rooms.stats().peers).toBe(1);
    a.ws.close();
  });

  it("expires inactive rooms (short TTL server)", async () => {
    const s = await createSignalingServer({ port: 0, roomTtlMs: 200, sweepMs: 50 });
    servers.push(s);
    const a = await openClient(s.port);
    send(a, { type: "CREATE_ROOM" });
    const created = await waitFor(a, (m) => m.type === "ROOM_CREATED");
    const room = created.room as string;
    await new Promise((r) => setTimeout(r, 400));
    send(a, { type: "JOIN_ROOM", room, role: "sender", requestId: "late" });
    const err = await waitFor(a, (m) => m.type === "ERROR");
    expect(["ROOM_EXPIRED", "ROOM_NOT_FOUND"]).toContain(err.code);
    a.ws.close();
  });

  it("rate-limits flooding clients", async () => {
    const s = await createSignalingServer({ port: 0, sweepMs: 50 });
    servers.push(s);
    const a = await openClient(s.port);
    // 40 rapid messages; bucket is 30 + small refill -> some must be limited.
    for (let i = 0; i < 40; i++) {
      send(a, { type: "JOIN_ROOM", room: "SS-DOESNOTEXIST01", role: "sender" });
    }
    await new Promise((r) => setTimeout(r, 500));
    const limited = a.inbox.filter((m) => m.type === "ERROR" && m.code === "RATE_LIMITED");
    expect(limited.length).toBeGreaterThan(0);
    a.ws.close();
  });

  it("rejects signaling from peers not in the room", async () => {
    const s = await createSignalingServer({ port: 0, sweepMs: 50 });
    servers.push(s);
    const a = await openClient(s.port);
    send(a, { type: "OFFER", room: "SS-NOSUCHROOM01", sdp: { type: "offer", sdp: SDP } });
    const err = await waitFor(a, (m) => m.type === "ERROR");
    expect(err.code).toBe("NOT_IN_ROOM");
    a.ws.close();
  });
});
