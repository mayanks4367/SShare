import { describe, it, expect, vi } from "vitest";
import { sanitizeHave, computeRemaining, encodeControl, decodeControl, assertIncomingMetadata } from "../src/transfer-engine/protocol.js";
import { classifyRoute, TransferPeer } from "../src/transfer-engine/peer.js";

describe("resumption hints", () => {
  it("round-trips have messages", () => {
    const raw = encodeControl({ t: "have", transferId: "SS-X", have: [0, 2] });
    expect(decodeControl(raw)).toEqual({ t: "have", transferId: "SS-X", have: [0, 2] });
  });

  it("sanitizes hostile hints and computes the remainder", () => {
    expect(sanitizeHave([0, 2, 2, 99, -1, 1.5], 3)).toEqual([0, 2]);
    expect(sanitizeHave(null, 3)).toEqual([]);
    expect(computeRemaining(4, new Set([0, 2]))).toEqual([1, 3]);
  });
});

describe("route classification", () => {
  it("maps candidate types without addresses", () => {
    expect(classifyRoute(null)).toBe("unknown");
    expect(classifyRoute({ localType: "host", remoteType: "srflx" })).toBe("direct");
    expect(classifyRoute({ localType: "host", remoteType: "relay" })).toBe("relay");
  });
});

describe("receiver trust boundary", () => {
  const CHECKSUM = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
  function bareReceiver(events: Record<string, unknown> = {}) {
    const peer = Object.create(TransferPeer.prototype) as TransferPeer;
    const p = peer as unknown as Record<string, unknown>;
    p["role"] = "receiver";
    p["events"] = events;
    p["opts"] = { resumeWaitMs: 0, backpressureBytes: 1024 * 1024, connectionTimeoutMs: 0 };
    p["recvMeta"] = null;
    p["recvChunks"] = [];
    p["recvBytes"] = 0;
    p["haveHints"] = new Map();
    p["haveWaiters"] = new Map();
    return peer as unknown as { handleMessage(d: string | ArrayBuffer): Promise<void> };
  }
  function goodMeta(over: Record<string, unknown> = {}) {
    return {
      transferId: "SS-TEST01", fileName: "a.bin", fileSize: 10,
      mimeType: "application/octet-stream", chunkSize: 65536,
      totalChunks: 1, checksum: CHECKSUM, createdAt: 1, ...over,
    };
  }

  it("rejects hostile manifests without allocating", async () => {
    const onError = vi.fn();
    const h = bareReceiver({ onError, onTransfer: () => {} });
    await h.handleMessage(encodeControl({ t: "meta", meta: goodMeta({ totalChunks: 999999999 }) } as never));
    await h.handleMessage(encodeControl({ t: "meta", meta: { transferId: "SS-X" } as never }));
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("ignores done for another transfer", async () => {
    const onTransfer = vi.fn();
    const h = bareReceiver({ onTransfer });
    await h.handleMessage(encodeControl({ t: "done", transferId: "SS-OTHER" }));
    expect(onTransfer).not.toHaveBeenCalled();
  });

  it("assertIncomingMetadata enforces shape + bounds", () => {
    expect(() => assertIncomingMetadata(goodMeta())).not.toThrow();
    expect(() => assertIncomingMetadata({ ...goodMeta(), fileSize: -1 })).toThrow();
    expect(() => assertIncomingMetadata(null)).toThrow();
  });
});
