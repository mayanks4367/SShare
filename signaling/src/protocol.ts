/**
 * SShare signaling protocol (v1).
 *
 * Transport: WebSocket text frames carrying exactly one JSON object.
 * Binary frames are rejected. The server NEVER stores or relays file bytes —
 * TRANSFER_* messages carry metadata headers only (see validation).
 *
 * This module has zero socket dependencies so Rust / Android / iOS /
 * desktop clients can port the same rules. See PROTOCOL.md for the full spec.
 */

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export const CLIENT_MESSAGE_TYPES = [
  "CREATE_ROOM",
  "JOIN_ROOM",
  "OFFER",
  "ANSWER",
  "ICE_CANDIDATE",
  "LEAVE",
  "TRANSFER_READY",
  "TRANSFER_COMPLETE",
] as const;

export const SERVER_MESSAGE_TYPES = [
  "WELCOME",
  "ROOM_CREATED",
  "JOINED",
  "PEER_JOINED",
  "OFFER",
  "ANSWER",
  "ICE_CANDIDATE",
  "PEER_LEFT",
  "LEFT",
  "TRANSFER_READY",
  "TRANSFER_COMPLETE",
  "ERROR",
] as const;

export type ClientMessageType = (typeof CLIENT_MESSAGE_TYPES)[number];
export type ServerMessageType = (typeof SERVER_MESSAGE_TYPES)[number];

export type Role = "sender" | "receiver";

export interface PeerInfo {
  clientId: string;
  role: Role;
}

export interface SdpPayload {
  type: "offer" | "answer";
  sdp: string;
}

export interface IceCandidatePayload {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

/** Metadata header only — file bytes must never appear on the wire. */
export interface TransferDescriptor {
  transferId: string;
  fileName: string;
  fileSize: number;
  chunks: number;
}

export type ClientMessage =
  | { type: "CREATE_ROOM"; requestId?: string; maxPeers?: number; ttlSec?: number }
  | { type: "JOIN_ROOM"; room: string; role: Role; requestId?: string }
  | { type: "OFFER"; room: string; sdp: SdpPayload; requestId?: string }
  | { type: "ANSWER"; room: string; sdp: SdpPayload; requestId?: string }
  | { type: "ICE_CANDIDATE"; room: string; candidate: IceCandidatePayload; requestId?: string }
  | { type: "LEAVE"; room: string; requestId?: string }
  | ({ type: "TRANSFER_READY"; room: string; requestId?: string } & Partial<TransferDescriptor>)
  | ({ type: "TRANSFER_COMPLETE"; room: string; requestId?: string } & Partial<TransferDescriptor>);

export type ServerMessage =
  | { type: "WELCOME"; clientId: string }
  | { type: "ROOM_CREATED"; room: string; expiresAt: number; maxPeers: number; requestId?: string }
  | { type: "JOINED"; room: string; clientId: string; peers: PeerInfo[]; expiresAt: number; requestId?: string }
  | { type: "PEER_JOINED"; room: string; peer: PeerInfo }
  | { type: "OFFER"; room: string; from: string; sdp: SdpPayload }
  | { type: "ANSWER"; room: string; from: string; sdp: SdpPayload }
  | { type: "ICE_CANDIDATE"; room: string; from: string; candidate: IceCandidatePayload }
  | { type: "PEER_LEFT"; room: string; peer: string; reason: string }
  | { type: "LEFT"; room: string }
  | ({ type: "TRANSFER_READY"; room: string; from: string } & Partial<TransferDescriptor>)
  | ({ type: "TRANSFER_COMPLETE"; room: string; from: string } & Partial<TransferDescriptor>)
  | { type: "ERROR"; code: string; message: string; requestId?: string };

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const LIMITS = {
  MAX_MESSAGE_BYTES: 128 * 1024,
  MAX_SDP_BYTES: 64 * 1024,
  MIN_SDP_BYTES: 32,
  MAX_CANDIDATE_BYTES: 4096,
  ROOM_ID_RE: /^[A-Z0-9-]{3,32}$/,
  MAX_PEERS_MIN: 2,
  MAX_PEERS_MAX: 8,
  TTL_MIN_SEC: 60,
  TTL_MAX_SEC: 4 * 3600,
  DEFAULT_TTL_SEC: 30 * 60,
  MAX_FILENAME_LEN: 255,
  MAX_FILE_SIZE: 50 * 1024 * 1024 * 1024, // 50 GiB header sanity cap
  MAX_TRANSFER_ID_LEN: 64,
} as const;

export const ERROR_CODES = [
  "INVALID_JSON",
  "UNKNOWN_TYPE",
  "VALIDATION_ERROR",
  "ROOM_NOT_FOUND",
  "ROOM_EXPIRED",
  "ROOM_FULL",
  "NOT_IN_ROOM",
  "RATE_LIMITED",
  "PAYLOAD_TOO_LARGE",
] as const;

// ---------------------------------------------------------------------------
// Validation (pure functions — port these 1:1 on other platforms)
// ---------------------------------------------------------------------------

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** File bytes must never be signaled. Reject anything smuggling payloads. */
const FORBIDDEN_KEYS = ["data", "chunk", "chunks_blob", "blob", "bytes", "payload", "fileData", "buffer"];

export function containsFilePayload(v: unknown): boolean {
  if (!isRecord(v)) return false;
  for (const k of Object.keys(v)) {
    if (FORBIDDEN_KEYS.includes(k)) return true;
  }
  return false;
}

function checkRequestId(v: Record<string, unknown>): string | null {
  if (v.requestId === undefined) return null;
  if (typeof v.requestId !== "string" || v.requestId.length > 128) {
    return "requestId must be a string <= 128 chars";
  }
  return null;
}

function checkRoom(v: Record<string, unknown>): string | null {
  if (typeof v.room !== "string" || !LIMITS.ROOM_ID_RE.test(v.room)) {
    return "room must match /^[A-Z0-9-]{3,32}$/";
  }
  return null;
}

function checkSdp(v: unknown): string | null {
  if (!isRecord(v)) return "sdp must be an object";
  if (v.type !== "offer" && v.type !== "answer") return "sdp.type must be offer|answer";
  if (typeof v.sdp !== "string") return "sdp.sdp must be a string";
  if (v.sdp.length < LIMITS.MIN_SDP_BYTES || v.sdp.length > LIMITS.MAX_SDP_BYTES) {
    return `sdp.sdp must be ${LIMITS.MIN_SDP_BYTES}..${LIMITS.MAX_SDP_BYTES} chars`;
  }
  if (!v.sdp.startsWith("v=")) return "sdp.sdp must start with v=";
  return null;
}

function checkCandidate(v: unknown): string | null {
  if (!isRecord(v)) return "candidate must be an object";
  if (typeof v.candidate !== "string" || v.candidate.length === 0) {
    return "candidate.candidate must be a non-empty string";
  }
  if (v.candidate.length > LIMITS.MAX_CANDIDATE_BYTES) {
    return `candidate.candidate must be <= ${LIMITS.MAX_CANDIDATE_BYTES} chars`;
  }
  return null;
}

function checkTransferFields(v: Record<string, unknown>): string | null {
  if (v.transferId !== undefined) {
    if (typeof v.transferId !== "string" || v.transferId.length === 0 || v.transferId.length > LIMITS.MAX_TRANSFER_ID_LEN) {
      return "transferId must be a non-empty string <= 64 chars";
    }
  }
  if (v.fileName !== undefined) {
    if (typeof v.fileName !== "string" || v.fileName.length === 0 || v.fileName.length > LIMITS.MAX_FILENAME_LEN) {
      return "fileName must be 1..255 chars";
    }
  }
  if (v.fileSize !== undefined) {
    if (typeof v.fileSize !== "number" || !Number.isFinite(v.fileSize) || v.fileSize < 0 || v.fileSize > LIMITS.MAX_FILE_SIZE) {
      return "fileSize must be a number in range";
    }
  }
  if (v.chunks !== undefined) {
    if (typeof v.chunks !== "number" || !Number.isInteger(v.chunks) || v.chunks < 1 || v.chunks > 1_000_000) {
      return "chunks must be an integer in range";
    }
  }
  return null;
}

/**
 * Validate a parsed client message. Returns null when valid,
 * otherwise a human-readable reason for the ERROR frame.
 */
export function validateClientMessage(msg: unknown): string | null {
  if (!isRecord(msg)) return "message must be a JSON object";
  if (containsFilePayload(msg)) return "file bytes are forbidden on the signaling channel";
  if (typeof msg.type !== "string") return "missing message type";
  if (!(CLIENT_MESSAGE_TYPES as readonly string[]).includes(msg.type)) {
    return `unknown message type ${String(msg.type).slice(0, 64)}`;
  }
  const reqErr = checkRequestId(msg);
  if (reqErr) return reqErr;

  switch (msg.type) {
    case "CREATE_ROOM": {
      if (msg.maxPeers !== undefined) {
        if (typeof msg.maxPeers !== "number" || !Number.isInteger(msg.maxPeers) ||
            msg.maxPeers < LIMITS.MAX_PEERS_MIN || msg.maxPeers > LIMITS.MAX_PEERS_MAX) {
          return `maxPeers must be an integer ${LIMITS.MAX_PEERS_MIN}..${LIMITS.MAX_PEERS_MAX}`;
        }
      }
      if (msg.ttlSec !== undefined) {
        if (typeof msg.ttlSec !== "number" || !Number.isInteger(msg.ttlSec) ||
            msg.ttlSec < LIMITS.TTL_MIN_SEC || msg.ttlSec > LIMITS.TTL_MAX_SEC) {
          return `ttlSec must be an integer ${LIMITS.TTL_MIN_SEC}..${LIMITS.TTL_MAX_SEC}`;
        }
      }
      return null;
    }
    case "JOIN_ROOM": {
      const r = checkRoom(msg);
      if (r) return r;
      if (msg.role !== "sender" && msg.role !== "receiver") return "role must be sender|receiver";
      return null;
    }
    case "OFFER":
    case "ANSWER": {
      const r = checkRoom(msg);
      if (r) return r;
      return checkSdp(msg.sdp);
    }
    case "ICE_CANDIDATE": {
      const r = checkRoom(msg);
      if (r) return r;
      return checkCandidate(msg.candidate);
    }
    case "LEAVE": {
      return checkRoom(msg);
    }
    case "TRANSFER_READY":
    case "TRANSFER_COMPLETE": {
      const r = checkRoom(msg);
      if (r) return r;
      return checkTransferFields(msg);
    }
    default:
      return "unknown message type";
  }
}

/** Serialize a server message (single JSON text frame). */
export function encodeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}
