import { describe, expect, it, vi } from "vitest";
import { SignalingClient } from "@/lib/signaling";

/** In-memory WebSocket double: capture sent frames, script inbound ones. */
class MockSocket {
  static instances: MockSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 1; // OPEN
  onopen: ((ev: object) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: object) => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(public url: string) {
    MockSocket.instances.push(this);
  }

  open() {
    this.onopen?.({});
  }

  receive(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }
}

function installMock() {
  MockSocket.instances = [];
  vi.stubGlobal("WebSocket", MockSocket);
  return MockSocket;
}

async function waitForSocket(n: number, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (MockSocket.instances.length < n) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`socket ${n} never opened`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("SignalingClient", () => {
  it("connects and captures the WELCOME clientId", async () => {
    installMock();
    const client = new SignalingClient("ws://x/ws");
    const p = client.connect();
    const sock = MockSocket.instances[0];
    expect(sock).toBeDefined();
    sock?.open();
    sock?.receive({ type: "WELCOME", clientId: "c-1" });
    await p;
    expect(client.clientId).toBe("c-1");
    client.close();
    vi.unstubAllGlobals();
  });

  it("creates a room and resolves ROOM_CREATED by requestId", async () => {
    installMock();
    const client = new SignalingClient("ws://x/ws");
    const p = client.connect();
    MockSocket.instances[0]?.open();
    await p;
    const creating = client.createRoom();
    const sent = JSON.parse(MockSocket.instances[0]?.sent[0] as string) as {
      [key: string]: unknown;
    };
    expect(sent["type"]).toBe("CREATE_ROOM");
    MockSocket.instances[0]?.receive({
      type: "ROOM_CREATED",
      room: "SS-ABC123",
      expiresAt: 1,
      requestId: sent["requestId"],
    });
    await expect(creating).resolves.toEqual({ room: "SS-ABC123", expiresAt: 1 });
    client.close();
    vi.unstubAllGlobals();
  });

  it("routes offers, ICE and errors to callbacks", async () => {
    installMock();
    const onOffer = vi.fn();
    const onIce = vi.fn();
    const onErrorMsg = vi.fn();
    const client = new SignalingClient("ws://x/ws", { onOffer, onIce, onErrorMsg });
    const p = client.connect();
    MockSocket.instances[0]?.open();
    await p;
    MockSocket.instances[0]?.receive({ type: "WELCOME", clientId: "c-9" });
    MockSocket.instances[0]?.receive({
      type: "OFFER",
      room: "SS-1",
      from: "peer",
      sdp: { type: "offer", sdp: "v=0" },
    });
    MockSocket.instances[0]?.receive({
      type: "ICE_CANDIDATE",
      room: "SS-1",
      from: "peer",
      candidate: { candidate: "c" },
    });
    MockSocket.instances[0]?.receive({ type: "ERROR", code: "ROOM_FULL", message: "full" });
    expect(onOffer).toHaveBeenCalledWith("peer", { type: "offer", sdp: "v=0" });
    expect(onIce).toHaveBeenCalledWith("peer", { candidate: "c" });
    expect(onErrorMsg).toHaveBeenCalledWith("ROOM_FULL", "full");
    client.close();
    vi.unstubAllGlobals();
  });

  it("rejects the promise on ERROR replies", async () => {
    installMock();
    const client = new SignalingClient("ws://x/ws");
    const p = client.connect();
    MockSocket.instances[0]?.open();
    await p;
    const joining = client.join("SS-NOPE", "receiver");
    const sent = JSON.parse(MockSocket.instances[0]?.sent[0] as string) as {
      [key: string]: unknown;
    };
    MockSocket.instances[0]?.receive({
      type: "ERROR",
      code: "ROOM_NOT_FOUND",
      message: "gone",
      requestId: sent["requestId"],
    });
    await expect(joining).rejects.toThrow(/ROOM_NOT_FOUND/);
    client.close();
    vi.unstubAllGlobals();
  });

  it("retries failed connects with backoff, then succeeds", async () => {
    installMock();
    const attempts: Array<[number, number]> = [];
    const client = new SignalingClient("ws://x/ws");
    const p = client.connectWithRetry({
      attempts: 3,
      baseDelayMs: 10, // clamped to the 100 ms floor
      onAttempt: (n, max) => attempts.push([n, max]),
    });
    // Fail twice…
    await waitForSocket(1);
    MockSocket.instances[0]?.onerror?.({});
    await waitForSocket(2);
    MockSocket.instances[1]?.onerror?.({});
    // …succeed on the third attempt.
    await waitForSocket(3);
    MockSocket.instances[2]?.open();
    await p;
    expect(attempts).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(MockSocket.instances).toHaveLength(3);
    client.close();
    vi.unstubAllGlobals();
  });

  it("gives up after exhausting attempts", async () => {
    installMock();
    const client = new SignalingClient("ws://x/ws");
    const p = client.connectWithRetry({ attempts: 2, baseDelayMs: 10 });
    await waitForSocket(1);
    MockSocket.instances[0]?.onerror?.({});
    await waitForSocket(2);
    MockSocket.instances[1]?.onerror?.({});
    await expect(p).rejects.toThrow(/signaling connection failed/);
    client.close();
    vi.unstubAllGlobals();
  });

  it("aborts retries when the run is retired", async () => {
    installMock();
    let current = true;
    const client = new SignalingClient("ws://x/ws");
    const p = client.connectWithRetry({
      attempts: 5,
      baseDelayMs: 10,
      isCurrent: () => current,
    });
    await new Promise((r) => setTimeout(r, 0));
    current = false;
    MockSocket.instances[0]?.onerror?.({});
    await expect(p).rejects.toThrow();
    expect(MockSocket.instances).toHaveLength(1);
    client.close();
    vi.unstubAllGlobals();
  });
});
