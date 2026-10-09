import { describe, it, expect } from "vitest";
import { sha256Hex, isHexSha256 } from "../src/transfer-engine/checksum.js";

describe("checksum verification", () => {
  it("matches known SHA-256 vector for 'abc'", async () => {
    const data = new TextEncoder().encode("abc");
    expect(await sha256Hex(data)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("detects single-bit corruption", async () => {
    const a = new TextEncoder().encode("hello world");
    const b = new Uint8Array(a);
    b[0] ^= 1;
    expect(await sha256Hex(a)).not.toBe(await sha256Hex(b));
  });

  it("validates hex shape", () => {
    expect(isHexSha256("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")).toBe(true);
    expect(isHexSha256("xyz")).toBe(false);
    expect(isHexSha256("")).toBe(false);
  });
});
