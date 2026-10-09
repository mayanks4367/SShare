/**
 * In-memory room + peer registry.
 * No file data is ever stored here — only presence (clientId, role).
 */
import { randomUUID } from "node:crypto";
import type { PeerInfo, Role } from "./protocol.js";

export interface RoomOptions {
  maxPeers: number;
  ttlMs: number;
}

export interface Room {
  id: string;
  createdAt: number;
  /** Last activity (join/message). Drives expiry for inactive rooms. */
  lastActive: number;
  expiresAt: number;
  maxPeers: number;
  peers: Map<string, { role: Role; joinedAt: number }>;
}

const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateRoomId(): string {
  let s = "";
  const bytes = new Uint8Array(6);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  for (const b of bytes) s += ID_ALPHABET[b % ID_ALPHABET.length];
  return `SS-${s}`;
}

export function newClientId(): string {
  return randomUUID();
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  /** Reverse index: clientId -> roomId (one room per socket). */
  private membership = new Map<string, string>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get size(): number {
    return this.rooms.size;
  }

  createRoom(opts: RoomOptions, idHint?: string): Room {
    let id = idHint ?? generateRoomId();
    for (let i = 0; i < 10 && this.rooms.has(id); i++) id = generateRoomId();
    if (this.rooms.has(id)) throw new Error("room id collision, retry");
    const t = this.now();
    const room: Room = {
      id,
      createdAt: t,
      lastActive: t,
      expiresAt: t + opts.ttlMs,
      maxPeers: opts.maxPeers,
      peers: new Map(),
    };
    this.rooms.set(id, room);
    return room;
  }

  getRoom(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  isExpired(room: Room): boolean {
    return this.now() >= room.expiresAt;
  }

  touch(room: Room): void {
    room.lastActive = this.now();
  }

  joinRoom(roomId: string, clientId: string, role: Role): { room: Room; peers: PeerInfo[] } {
    const room = this.rooms.get(roomId);
    if (!room) throw new RoomError("ROOM_NOT_FOUND", `room ${roomId} not found`);
    if (this.isExpired(room)) {
      this.rooms.delete(roomId);
      throw new RoomError("ROOM_EXPIRED", `room ${roomId} expired`);
    }
    if (room.peers.has(clientId)) {
      room.peers.get(clientId)!.role = role;
    } else {
      if (room.peers.size >= room.maxPeers) {
        throw new RoomError("ROOM_FULL", `room ${roomId} is full (${room.maxPeers})`);
      }
      room.peers.set(clientId, { role, joinedAt: this.now() });
    }
    this.membership.set(clientId, roomId);
    this.touch(room);
    return {
      room,
      peers: [...room.peers.entries()]
        .filter(([id]) => id !== clientId)
        .map(([id, p]) => ({ clientId: id, role: p.role })),
    };
  }

  /** Remove a client from its room. Returns room + whether room became empty. */
  leaveRoom(clientId: string): { room: Room; emptied: boolean } | null {
    const roomId = this.membership.get(clientId);
    if (!roomId) return null;
    const room = this.rooms.get(roomId);
    this.membership.delete(clientId);
    if (!room) return null;
    room.peers.delete(clientId);
    if (room.peers.size === 0) {
      this.rooms.delete(roomId);
      return { room, emptied: true };
    }
    this.touch(room);
    return { room, emptied: false };
  }

  roomOf(clientId: string): Room | undefined {
    const id = this.membership.get(clientId);
    return id ? this.rooms.get(id) : undefined;
  }

  inRoom(clientId: string, roomId: string): boolean {
    return this.membership.get(clientId) === roomId && this.rooms.has(roomId);
  }

  /** Delete rooms past expiry. Returns deleted ids. */
  sweepExpired(): string[] {
    const dead: string[] = [];
    for (const [id, room] of this.rooms) {
      if (this.isExpired(room)) {
        dead.push(id);
        for (const peerId of room.peers.keys()) this.membership.delete(peerId);
        this.rooms.delete(id);
      }
    }
    return dead;
  }

  stats(): { rooms: number; peers: number } {
    let peers = 0;
    for (const r of this.rooms.values()) peers += r.peers.size;
    return { rooms: this.rooms.size, peers };
  }
}

export class RoomError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
