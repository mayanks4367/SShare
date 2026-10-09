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
  if (m.fileSize < 0) throw new Error("bad metadata: fileSize");
  if (m.chunkSize < 1 || m.chunkSize > 1024 * 1024) {
    throw new Error("bad metadata: chunkSize");
  }
  if (m.totalChunks !== totalChunksFor(m.fileSize, m.chunkSize)) {
    throw new Error(
      `bad metadata: totalChunks ${m.totalChunks} inconsistent with size ${m.fileSize}/${m.chunkSize}`,
    );
  }
  if (!isHexSha256(m.checksum)) throw new Error("bad metadata: checksum");
}

const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateSessionId(): string {
  let s = "";
  const buf = new Uint8Array(6);
  const g = globalThis as unknown as { crypto?: Crypto };
  if (g.crypto?.getRandomValues) g.crypto.getRandomValues(buf);
  else for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  for (const b of buf) s += ID_ALPHABET[b % ID_ALPHABET.length];
  return `SS-${s}`;
}
