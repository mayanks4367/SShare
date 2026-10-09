import { describe, it, expect } from "vitest";
import {
  splitBytes,
  reassembleByIndex,
  totalChunksFor,
  clampChunkSize,
  DEFAULT_CHUNK_SIZE,
} from "../src/transfer-engine/chunker.js";

function seq(n: number): Uint8Array {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = i % 251;
  return a;
}

describe("chunk splitting", () => {
  it("single small file fits in one clamped chunk", () => {
    const out = splitBytes(seq(10), 64 * 1024);
    expect(out).toHaveLength(1);
    expect(out[0].length).toBe(10);
  });

  it("totalChunksFor math", () => {
    expect(totalChunksFor(0, 1024)).toBe(1);
    expect(totalChunksFor(10, 4)).toBe(3);
    expect(totalChunksFor(8, 4)).toBe(2);
    expect(totalChunksFor(1, 1024)).toBe(1);
  });

  it("clamps chunk size", () => {
    expect(clampChunkSize(1)).toBe(4 * 1024);
    expect(clampChunkSize(1e9)).toBe(256 * 1024);
    expect(clampChunkSize(64 * 1024)).toBe(64 * 1024);
    expect(clampChunkSize(Number.NaN)).toBe(DEFAULT_CHUNK_SIZE);
  });

  it("empty input -> single empty chunk", () => {
    expect(splitBytes(new Uint8Array(0), 64 * 1024)).toHaveLength(1);
  });

  it(" Default chunk splits 200KiB into 4 chunks", () => {
    const data = seq(200 * 1024);
    const chunks = splitBytes(data, 64 * 1024);
    expect(chunks).toHaveLength(4);
    expect(chunks[0].length).toBe(64 * 1024);
    expect(chunks[3].length).toBe(200 * 1024 - 3 * 64 * 1024);
  });
});
