/**
 * Chunker: pure splitting / reassembly helpers.
 * No WebRTC, no DOM — fully unit-testable.
 * Later this can delegate to SShare Rust/WASM chunking.
 */

export const DEFAULT_CHUNK_SIZE = 64 * 1024; // 64 KiB, safe for DataChannel
export const MIN_CHUNK_SIZE = 4 * 1024;
export const MAX_CHUNK_SIZE = 256 * 1024;

export function clampChunkSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_CHUNK_SIZE;
  return Math.min(MAX_CHUNK_SIZE, Math.max(MIN_CHUNK_SIZE, Math.floor(n)));
}

export function totalChunksFor(fileSize: number, chunkSize: number): number {
  if (fileSize === 0) return 1;
  return Math.ceil(fileSize / chunkSize);
}

/** Split raw bytes into ordered payload chunks (copies views). */
export function splitBytes(data: Uint8Array, chunkSize: number): Uint8Array[] {
  const size = clampChunkSize(chunkSize);
  if (data.length === 0) return [new Uint8Array(0)];
  const out: Uint8Array[] = [];
  for (let off = 0; off < data.length; off += size) {
    out.push(data.slice(off, off + size));
  }
  return out;
}

/**
 * Reassemble chunks by index.
 * `chunksByIndex[i]` must be present for every i in [0, total).
 * Throws on missing/out-of-range data. Order of arrival does not matter.
 */
export function reassembleByIndex(
  chunksByIndex: (Uint8Array | undefined)[],
  totalChunks: number,
  fileSize: number,
): Uint8Array {
  if (chunksByIndex.length < totalChunks) {
    throw new Error(
      `missing chunks: have array len ${chunksByIndex.length}, need ${totalChunks}`,
    );
  }
  for (let i = 0; i < totalChunks; i++) {
    if (!chunksByIndex[i]) throw new Error(`missing chunk index ${i}`);
  }
  const out = new Uint8Array(fileSize);
  let off = 0;
  for (let i = 0; i < totalChunks; i++) {
    const c = chunksByIndex[i]!;
    out.set(c, off);
    off += c.length;
  }
  if (off !== fileSize) {
    throw new Error(`reassembled size ${off} != expected ${fileSize}`);
  }
  return out;
}

/** Async split of a Blob/File without loading all into RAM at once. */
export async function* iterateBlobChunks(
  blob: Blob,
  chunkSize: number,
): AsyncGenerator<{ index: number; data: Uint8Array }, void, void> {
  const size = clampChunkSize(chunkSize);
  const total = totalChunksFor(blob.size, size);
  for (let i = 0; i < total; i++) {
    const start = i * size;
    const slice = blob.slice(start, start + size);
    const buf = new Uint8Array(await slice.arrayBuffer());
    yield { index: i, data: buf };
  }
}
