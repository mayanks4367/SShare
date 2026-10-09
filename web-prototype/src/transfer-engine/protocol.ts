/**
 * Wire protocol: framing for the single reliable ordered DataChannel.
 * - strings  -> JSON ControlMessage
 * - binaries -> 4-byte BE chunk index + raw payload
 * Keeping one channel makes manual-signaling demos trivial; a future
 * revision can split into control/data channels without changing framing.
 */
import type { ControlMessage, TransferMetadata } from "./types.js";
import { clampChunkSize, totalChunksFor } from "./chunker.js";
import { isHexSha256 } from "./checksum.js";

export const PROTOCOL_CHANNEL = "ssshare-file-v1";
export const CHUNK_HEADER_BYTES = 4;

export function encodeChunk(index: number, payload: Uint8Array): ArrayBuffer {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`invalid chunk index ${index}`);
  }
  const out = new Uint8Array(CHUNK_HEADER_BYTES + payload.length);
  new DataView(out.buffer).setUint32(0, index, false);
  out.set(payload, CHUNK_HEADER_BYTES);
  return out.buffer;
}

export function decodeChunk(buf: ArrayBuffer): {
  index: number;
  payload: Uint8Array;
} {
  if (buf.byteLength < CHUNK_HEADER_BYTES) {
    throw new Error(`chunk frame too short (${buf.byteLength}B)`);
  }
  const view = new DataView(buf);
  const index = view.getUint32(0, false);
  return { index, payload: new Uint8Array(buf, CHUNK_HEADER_BYTES) };
}

export function encodeControl(msg: ControlMessage): string {
  return JSON.stringify(msg);
}

export function decodeControl(raw: string): ControlMessage {
  const v = JSON.parse(raw) as ControlMessage;
  if (!v || typeof v !== "object" || typeof (v as { t?: unknown }).t !== "string") {
    throw new Error("invalid control message");
  }
  return v;
}

export function buildMetadata(args: {
  transferId: string;
  fileName: string;
  fileSize: number;
  mimeType?: string;
  chunkSize: number;
  checksum: string;
}): TransferMetadata {
  const chunkSize = clampChunkSize(args.chunkSize);
  if (!args.transferId) throw new Error("transferId required");
  if (!args.fileName) throw new Error("fileName required");
  if (args.fileSize < 0) throw new Error("fileSize must be >= 0");
  if (!isHexSha256(args.checksum)) throw new Error("checksum must be sha256 hex");
  return {
    transferId: args.transferId,
    fileName: args.fileName,
    fileSize: args.fileSize,
    mimeType: args.mimeType || "application/octet-stream",
    chunkSize,
    totalChunks: totalChunksFor(args.fileSize, chunkSize),
    checksum: args.checksum,
    createdAt: Date.now(),
  };
}

export function validateMetadata(m: TransferMetadata): void {
  if (!m.transferId || !m.fileName) throw new Error("bad metadata: id/name");
  if (m.fileName.length > MAX_FILENAME_LEN) throw new Error("bad metadata: fileName too long");
  if (m.fileSize < 0) throw new Error("bad metadata: fileSize");
  if (m.fileSize > MAX_FILE_SIZE) throw new Error("bad metadata: fileSize too large");
  if (m.chunkSize < 1 || m.chunkSize > 1024 * 1024) {
    throw new Error("bad metadata: chunkSize");
  }
  if (m.totalChunks !== totalChunksFor(m.fileSize, m.chunkSize)) {
    throw new Error(
      `bad metadata: totalChunks ${m.totalChunks} inconsistent with size ${m.fileSize}/${m.chunkSize}`,
    );
  }
  if (m.totalChunks > MAX_TOTAL_CHUNKS) throw new Error("bad metadata: too many chunks");
  if (!isHexSha256(m.checksum)) throw new Error("bad metadata: checksum");
}

/**
 * Validate an UNTRUSTED inbound manifest before the receiver allocates
 * anything. Throws on any violation.
 */
export function assertIncomingMetadata(v: unknown): TransferMetadata {
  if (typeof v !== "object" || v === null) throw new Error("bad metadata: not an object");
  const m = v as Record<string, unknown>;
  const str = (k: string): string => {
    const x = m[k];
    if (typeof x !== "string") throw new Error(`bad metadata: ${k} must be a string`);
    return x;
  };
  const num = (k: string): number => {
    const x = m[k];
    if (typeof x !== "number" || !Number.isFinite(x)) throw new Error(`bad metadata: ${k} must be a number`);
    return x;
  };
  const meta: TransferMetadata = {
    transferId: str("transferId"),
    fileName: str("fileName"),
    fileSize: num("fileSize"),
    mimeType: typeof m["mimeType"] === "string" ? (m["mimeType"] as string) : "application/octet-stream",
    chunkSize: num("chunkSize"),
    totalChunks: num("totalChunks"),
    checksum: str("checksum"),
    createdAt: typeof m["createdAt"] === "number" ? (m["createdAt"] as number) : 0,
  };
  if (!Number.isInteger(meta.fileSize) || !Number.isInteger(meta.chunkSize) || !Number.isInteger(meta.totalChunks)) {
    throw new Error("bad metadata: sizes must be integers");
  }
  validateMetadata(meta);
  return meta;
}

/** Largest single file accepted from a remote peer. */
export const MAX_FILE_SIZE = 50 * 1024 * 1024 * 1024;
/** Largest chunk count accepted (bounds the receiver's chunk table). */
export const MAX_TOTAL_CHUNKS = 1_000_000;
/** Longest file name accepted. */
export const MAX_FILENAME_LEN = 255;
/** Largest single DataChannel chunk frame accepted (header + payload). */
export const MAX_CHUNK_FRAME_BYTES = 2 * 1024 * 1024;

const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateSessionId(): string {  let s = "";
  const buf = new Uint8Array(6);
  const g = globalThis as unknown as { crypto?: Crypto };
  if (g.crypto?.getRandomValues) g.crypto.getRandomValues(buf);
  else for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  for (const b of buf) s += ID_ALPHABET[b % ID_ALPHABET.length];
  return `SS-${s}`;
}

/**
 * Sanitize a receiver `have` hint: integers in [0, total), deduplicated,
 * sorted. Malformed entries are dropped (never trust the peer blindly).
 */
export function sanitizeHave(have: unknown, totalChunks: number): number[] {
  if (!Array.isArray(have)) return [];
  const out = new Set<number>();
  for (const v of have) {
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < totalChunks) {
      out.add(v);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Indices still needing transfer, in ascending order. */
export function computeRemaining(totalChunks: number, have: ReadonlySet<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < totalChunks; i++) {
    if (!have.has(i)) out.push(i);
  }
  return out;
}
