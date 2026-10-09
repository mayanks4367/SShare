/**
 * Shared types for the modular WebRTC transfer engine.
 * Kept transport-agnostic so SShare Rust core can later replace
 * chunking/hashing without changing the peer layer.
 */

export interface TransferMetadata {
  /** Human-readable session id, e.g. "SS-7KQ2XA" (not secret). */
  transferId: string;
  fileName: string;
  /** Original byte length. */
  fileSize: number;
  mimeType: string;
  /** Logical chunk payload size in bytes (header excluded). */
  chunkSize: number;
  totalChunks: number;
  /** Lowercase hex SHA-256 of the whole original file. */
  checksum: string;
  createdAt: number;
}

export interface TransferProgress {
  bytesTransferred: number;
  totalBytes: number;
  percent: number;
  /** Bytes/sec (average since start). */
  speedBps: number;
  /** Seconds remaining, Infinity if speed is 0. */
  etaSec: number;
}

export type ConnectionStatus =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

export type TransferStatus =
  | "idle"
  | "waiting-channel"
  | "sending"
  | "receiving"
  | "verifying"
  | "complete"
  | "cancelled"
  | "error";

/** Control messages sent as DataChannel *strings* (JSON). Binary = chunk. */
export type ControlMessage =
  | { t: "meta"; meta: TransferMetadata }
  | { t: "done"; transferId: string }
  | { t: "cancel"; transferId: string; reason?: string }
  | { t: "error"; transferId: string; message: string };
