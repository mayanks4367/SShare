import { describe, it, expect } from "vitest";
import { splitBytes, reassembleByIndex } from "../src/transfer-engine/chunker.js";
import { encodeChunk, decodeChunk } from "../src/transfer-engine/protocol.js";

function seq(n: number): Uint8Array {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = (i * 7 + 3) % 256;
  return a;
}

describe("chunk ordering + reconstruction", () => {
  it("reassembles in-order chunks byte-identical", () => {
    const data = seq(150 * 1024);
    const chunks = splitBytes(data, 64 * 1024);
    const byIndex = chunks.map((c) => c);
    const out = reassembleByIndex(byIndex, chunks.length, data.length);
    expect(out).toEqual(data);
  });

  it("reassembles shuffled arrival order (simulates unordered delivery)", () => {
    const data = seq(100 * 1024 + 123);
    const chunks = splitBytes(data, 64 * 1024);
    // Simulate wire frames arriving reversed, decode, place by index.
    const frames = chunks.map((c, i) => encodeChunk(i, c)).reverse();
    const byIndex: (Uint8Array | undefined)[] = new Array(chunks.length);
    for (const f of frames) {
      const { index, payload } = decodeChunk(f);
      byIndex[index] = payload;
    }
    expect(reassembleByIndex(byIndex, chunks.length, data.length)).toEqual(data);
  });

  it("throws on missing chunk", () => {
    const data = seq(10 * 1024);
    const chunks = splitBytes(data, 4 * 1024);
    const byIndex: (Uint8Array | undefined)[] = [...chunks];
    byIndex[0] = undefined;
    expect(() => reassembleByIndex(byIndex, chunks.length, data.length)).toThrow(/missing chunk/);
  });

  it("frame header preserves index + payload", () => {
    const payload = new Uint8Array([1, 2, 3, 250]);
    const { index, payload: back } = decodeChunk(encodeChunk(42, payload));
    expect(index).toBe(42);
    expect(back).toEqual(payload);
  });
});
