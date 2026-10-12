import { describe, expect, it, vi } from "vitest";
import { TransferPeer, type PeerEvents } from "@/lib/transfer/peer";
import type { TransferMetadata } from "@/lib/transfer/types";
import { encodeChunk, encodeControl } from "@/lib/transfer/protocol";

const CHECKSUM = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

/** Receiver instance without a real RTCPeerConnection (none of these paths touch it). */
function bareReceiver(events: PeerEvents = {}) {
  const peer = Object.create(TransferPeer.prototype) as TransferPeer;
  const priv = peer as unknown as Record<string, unknown>;
  priv["role"] = "receiver";
  priv["events"] = events;
  priv["opts"] = { resumeWaitMs: 0, backpressureBytes: 1024 * 1024, connectionTimeoutMs: 0 };
  priv["recvMeta"] = null;
  priv["recvChunks"] = [];
  priv["recvBytes"] = 0;
  priv["haveHints"] = new Map();
  priv["haveWaiters"] = new Map();
  return {
    peer,
    handle: (data: string | ArrayBuffer) =>
      (
        peer as unknown as {
          handleMessage(d: string | ArrayBuffer): Promise<void>;
        }
      ).handleMessage(data),
  };
}

function goodMeta(over: Record<string, unknown> = {}) {
  return {
    transferId: "SS-TEST01",
    fileName: "a.bin",
    fileSize: 10,
    mimeType: "application/octet-stream",
    chunkSize: 65536,
    totalChunks: 1,
    checksum: CHECKSUM,
    createdAt: 1,
    ...over,
  };
}

describe("receiver trust boundary", () => {
  it("rejects a giant totalChunks without allocating", async () => {
    const onError = vi.fn();
    const onTransfer = vi.fn();
    const { handle } = bareReceiver({ onError, onTransfer });
    await handle(encodeControl({ t: "meta", meta: goodMeta({ totalChunks: 1_000_000_000 }) }));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onTransfer).toHaveBeenCalledWith("error");
  });

  it("rejects malformed manifests (missing fields, bad checksum, long name)", async () => {
    const onError = vi.fn();
    const { handle } = bareReceiver({ onError });
    await handle(
      encodeControl({ t: "meta", meta: { transferId: "SS-X" } as unknown as TransferMetadata }),
    );
    await handle(encodeControl({ t: "meta", meta: goodMeta({ checksum: "zzz" }) }));
    await handle(encodeControl({ t: "meta", meta: goodMeta({ fileName: "x".repeat(300) }) }));
    await handle(encodeControl({ t: "meta", meta: goodMeta({ fileSize: 2 ** 60 }) }));
    expect(onError).toHaveBeenCalledTimes(4);
  });

  it("ignores done/cancel/error for a different (or no) transfer", async () => {
    const onTransfer = vi.fn();
    const onCancelled = vi.fn();
    const onError = vi.fn();
    const { handle } = bareReceiver({ onTransfer, onCancelled, onError });
    await handle(encodeControl({ t: "done", transferId: "SS-OTHER" }));
    await handle(encodeControl({ t: "cancel", transferId: "SS-OTHER" }));
    await handle(encodeControl({ t: "error", transferId: "SS-OTHER", message: "x" }));
    expect(onTransfer).not.toHaveBeenCalled();
    expect(onCancelled).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops oversized chunk frames and byte overruns", async () => {
    const onError = vi.fn();
    const { peer, handle } = bareReceiver({ onError });
    await handle(
      encodeControl({ t: "meta", meta: goodMeta({ fileSize: 10, chunkSize: 4, totalChunks: 3 }) }),
    );
    const priv = peer as unknown as Record<string, unknown>;
    // 3 MiB frame: over the 2 MiB cap -> dropped silently.
    await handle(new Uint8Array(3 * 1024 * 1024).buffer);
    expect(priv["recvBytes"]).toBe(0);
    // 4+4 bytes fit in a 10-byte file; a third full chunk overruns it.
    await handle(encodeChunk(0, new Uint8Array(4)));
    await handle(encodeChunk(1, new Uint8Array(4)));
    await handle(encodeChunk(2, new Uint8Array(4)));
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("more bytes") }),
    );
  });
});
