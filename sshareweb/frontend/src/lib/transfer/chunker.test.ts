import { describe, expect, it } from "vitest";
import {
  clampChunkSize,
  DEFAULT_CHUNK_SIZE,
  reassembleByIndex,
  splitBytes,
  totalChunksFor,
} from "@/lib/transfer/chunker";

function seq(n: number): Uint8Array {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = i % 251;
  return a;
}

describe("chunker", () => {
  it("clamps chunk sizes to the DataChannel-safe range", () => {
    expect(clampChunkSize(1)).toBe(4 * 1024);
    expect(clampChunkSize(1e9)).toBe(256 * 1024);
    expect(clampChunkSize(64 * 1024)).toBe(64 * 1024);
    expect(clampChunkSize(Number.NaN)).toBe(DEFAULT_CHUNK_SIZE);
  });

  it("computes chunk counts including the empty-file edge", () => {
    expect(totalChunksFor(0, 1024)).toBe(1);
    expect(totalChunksFor(10, 4)).toBe(3);
    expect(totalChunksFor(8, 4)).toBe(2);
  });

  it("splits 200 KiB into 4 chunks at 64 KiB", () => {
    const chunks = splitBytes(seq(200 * 1024), 64 * 1024);
    expect(chunks).toHaveLength(4);
    expect(chunks[0]?.length).toBe(64 * 1024);
    expect(chunks[3]?.length).toBe(200 * 1024 - 3 * 64 * 1024);
  });

  it("reassembles byte-identical output regardless of arrival order", () => {
    const data = seq(100 * 1024 + 123);
    const chunks = splitBytes(data, 64 * 1024);
    const shuffled = [...chunks].reverse();
    const byIndex: Array<Uint8Array | undefined> = new Array(chunks.length);
    // Arrival order is reversed; placement is by index.
    const order = [...chunks.keys()].reverse();
    order.forEach((slot, k) => {
      byIndex[slot] = shuffled[k];
    });
    expect(reassembleByIndex(byIndex, chunks.length, data.length)).toEqual(data);
  });

  it("throws on missing chunks", () => {
    const data = seq(10 * 1024);
    const chunks = splitBytes(data, 4 * 1024);
    const byIndex: Array<Uint8Array | undefined> = [...chunks];
    byIndex[0] = undefined;
    expect(() => reassembleByIndex(byIndex, chunks.length, data.length)).toThrow(/missing chunk/);
  });
});
