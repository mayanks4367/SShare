import { describe, expect, it } from "vitest";
import { isHexSha256, sha256Hex } from "@/lib/transfer/checksum";

describe("checksum", () => {
  it("matches the known SHA-256 vector for 'abc'", async () => {
    const data = new TextEncoder().encode("abc");
    expect(await sha256Hex(data)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("detects single-bit corruption", async () => {
    const a = new TextEncoder().encode("hello world");
    const b = new Uint8Array(a);
    b[0] = (b[0] as number) ^ 1;
    expect(await sha256Hex(a)).not.toBe(await sha256Hex(b));
  });

  it("validates hex shape", () => {
    expect(isHexSha256("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")).toBe(
      true,
    );
    expect(isHexSha256("xyz")).toBe(false);
  });
});
