/**
 * Checksums: SHA-256 hex via WebCrypto (browser + Node 18+).
 */

function subtle(): SubtleCrypto {
  const g = globalThis as unknown as { crypto?: Crypto };
  if (g.crypto?.subtle) return g.crypto.subtle;
  throw new Error("WebCrypto subtle not available in this environment");
}

export async function sha256Hex(data: Uint8Array | ArrayBuffer): Promise<string> {
  // Avoid copying if data is already a plain ArrayBuffer; subtle rejects SharedArrayBuffer views.
  const buf: ArrayBuffer =
    data instanceof ArrayBuffer ? data : (new Uint8Array(data).buffer as ArrayBuffer);
  const digest = await subtle().digest("SHA-256", buf);
  return toHex(new Uint8Array(digest));
}

export async function sha256HexOfChunks(chunks: Uint8Array[]): Promise<string> {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    joined.set(c, off);
    off += c.length;
  }
  return sha256Hex(joined);
}

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function isHexSha256(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}
