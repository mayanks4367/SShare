import { describe, it, expect } from "vitest";
import { buildMetadata, validateMetadata, generateSessionId } from "../src/transfer-engine/protocol.js";

const CHECKSUM = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"; // sha256("test")

describe("transfer metadata", () => {
  it("builds consistent metadata (totalChunks derived)", () => {
    const m = buildMetadata({
      transferId: "SS-ABC123",
      fileName: "photo.png",
      fileSize: 200 * 1024,
      mimeType: "image/png",
      chunkSize: 64 * 1024,
      checksum: CHECKSUM,
    });
    expect(m.totalChunks).toBe(4);
    expect(m.chunkSize).toBe(64 * 1024);
    expect(() => validateMetadata(m)).not.toThrow();
  });

  it("empty file -> 1 chunk", () => {
    const m = buildMetadata({
      transferId: "SS-X",
      fileName: "empty.bin",
      fileSize: 0,
      chunkSize: 64 * 1024,
      checksum: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    expect(m.totalChunks).toBe(1);
  });

  it("rejects bad checksum / tampered totalChunks", () => {
    expect(() =>
      buildMetadata({
        transferId: "SS-X",
        fileName: "a",
        fileSize: 10,
        chunkSize: 64 * 1024,
        checksum: "not-hex",
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

  it("generates unique session ids with SS- prefix", () => {
    const a = generateSessionId();
    const b = generateSessionId();
    expect(a.startsWith("SS-")).toBe(true);
    expect(a).not.toBe(b);
  });
});
