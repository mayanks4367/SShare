import { describe, expect, it } from "vitest";
import {
  buildMetadata,
  computeRemaining,
  decodeChunk,
  decodeControl,
  encodeChunk,
  encodeControl,
  generateSessionId,
  sanitizeHave,
  validateMetadata,
} from "@/lib/transfer/protocol";

const CHECKSUM = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"; // sha256("test")

describe("transfer protocol", () => {
  it("round-trips chunk frames with index + payload", () => {
    const payload = new Uint8Array([1, 2, 3, 250]);
    const { index, payload: back } = decodeChunk(encodeChunk(42, payload));
    expect(index).toBe(42);
    expect(back).toEqual(payload);
  });

  it("rejects truncated frames", () => {
    expect(() => decodeChunk(new ArrayBuffer(2))).toThrow(/too short/);
  });

  it("round-trips control messages", () => {
    const raw = encodeControl({ t: "done", transferId: "SS-X" });
    expect(decodeControl(raw)).toEqual({ t: "done", transferId: "SS-X" });
    expect(() => decodeControl("not json")).toThrow();
  });

  it("builds consistent metadata", () => {
    const m = buildMetadata({
      transferId: "SS-ABC123",
      fileName: "photo.png",
      fileSize: 200 * 1024,
      mimeType: "image/png",
      chunkSize: 64 * 1024,
      checksum: CHECKSUM,
    });
    expect(m.totalChunks).toBe(4);
    expect(() => validateMetadata(m)).not.toThrow();
  });

  it("rejects bad checksums and tampered counts", () => {
    expect(() =>
      buildMetadata({
        transferId: "SS-X",
        fileName: "a",
        fileSize: 10,
        chunkSize: 64 * 1024,
        checksum: "nope",
      }),
    ).toThrow();
    const m = buildMetadata({
      transferId: "SS-X",
      fileName: "a",
      fileSize: 100,
      chunkSize: 64 * 1024,
      checksum: CHECKSUM,
    });
    expect(() => validateMetadata({ ...m, totalChunks: 999 })).toThrow();
  });

  it("generates unique SS- session ids", () => {
    const a = generateSessionId();
    const b = generateSessionId();
    expect(a).toMatch(/^SS-[A-Z2-9]{6}$/);
    expect(a).not.toBe(b);
  });

  it("round-trips have hints and sanitizes hostile input", () => {
    const raw = encodeControl({ t: "have", transferId: "SS-X", have: [0, 2] });
    expect(decodeControl(raw)).toEqual({ t: "have", transferId: "SS-X", have: [0, 2] });
    expect(sanitizeHave([0, 2, 2, 9, -1, 1.5, "x", null], 3)).toEqual([0, 2]);
    expect(sanitizeHave("nope", 3)).toEqual([]);
    expect(computeRemaining(4, new Set([0, 2]))).toEqual([1, 3]);
    expect(computeRemaining(2, new Set())).toEqual([0, 1]);
  });
});
