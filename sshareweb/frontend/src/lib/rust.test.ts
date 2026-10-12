import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadViaGateway, GatewayError, getWebManifest, type WebManifest } from "@/lib/rust";
import { sha256Hex } from "@/lib/transfer";

const FILE_ID = "ab".repeat(32);

function manifestFor(chunks: Uint8Array[], fileSize: number): WebManifest {
  return {
    file_id: FILE_ID,
    file_name: "demo.bin",
    mime: "application/octet-stream",
    file_size: fileSize,
    chunk_size: 4,
    total_chunks: chunks.length,
    chunk_hashes_blake3: chunks.map((_, i) => `b${i}`),
    chunk_hashes_sha256: [],
    sha256: null,
    compressed: false,
    created_at: 1,
  };
}

async function withHashes(m: WebManifest, chunks: Uint8Array[]): Promise<WebManifest> {
  return {
    ...m,
    chunk_hashes_sha256: await Promise.all(chunks.map((c) => sha256Hex(c))),
    sha256: await sha256Hex(
      (() => {
        const out = new Uint8Array(m.file_size);
        let off = 0;
        for (const c of chunks) {
          out.set(c, off);
          off += c.length;
        }
        return out;
      })(),
    ),
  };
}

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => handler(url)),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rust gateway client", () => {
  it("fetches and validates the web manifest, mapping 404s", async () => {
    mockFetch((url) =>
      url.endsWith(`/api/web-manifest/${FILE_ID}`)
        ? Response.json({ file_id: FILE_ID, file_name: "a.bin", chunk_hashes_blake3: ["x"] })
        : new Response("nope", { status: 404 }),
    );
    const m = await getWebManifest("http://gw", FILE_ID);
    expect(m.file_id).toBe(FILE_ID);
    expect(m.mime).toBe("application/octet-stream");
    await expect(getWebManifest("http://gw", "missing")).rejects.toBeInstanceOf(GatewayError);
  });

  it("downloads chunks and verifies whole-file SHA-256", async () => {
    const chunks = [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6])];
    const manifest = await withHashes(manifestFor(chunks, 6), chunks);
    mockFetch((url) => {
      const m = url.match(/\/api\/chunks\/[^/]+\/(\d+)$/);
      if (!m) return new Response("?", { status: 404 });
      const bytes = chunks[Number(m[1])];
      if (!bytes) return new Response("?", { status: 404 });
      return new Response(bytes as unknown as BodyInit);
    });
    const progress: Array<[number, number]> = [];
    const out = await downloadViaGateway("http://gw", manifest, {
      onProgress: (b, t) => progress.push([b, t]),
    });
    expect(out).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    expect(progress.at(-1)).toEqual([6, 6]);
  });

  it("rejects tampered chunk bytes", async () => {
    const chunks = [new Uint8Array([1, 2, 3, 4])];
    const manifest = await withHashes(manifestFor(chunks, 4), chunks);
    mockFetch(() => new Response(new Uint8Array([9, 9, 9, 9]) as unknown as BodyInit));
    await expect(downloadViaGateway("http://gw", manifest)).rejects.toThrow(/SHA-256/);
  });
});
