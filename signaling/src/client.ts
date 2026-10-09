/**
 * Minimal WebSocket signaling client (browser + Node).
 *
 * This is the ONLY file the web app / native clients need. The server
 * never imports it — signaling stays separate from the file-transfer layer.
 * File bytes must never be passed through here; TRANSFER_* carries headers.
 */
import type {
  ClientMessage,
  IceCandidatePayload,
  PeerInfo,
  Role,
  SdpPayload,
  ServerMessage,
} from "./protocol.js";

export interface SignalingEvents {
  onPeers?: (peers: PeerInfo[]) => void;
  onPeerJoined?: (peer: PeerInfo) => void;
  onOffer?: (from: string, sdp: SdpPayload) => void;
  onAnswer?: (from: string, sdp: SdpPayload) => void;
  onIce?: (from: string, candidate: IceCandidatePayload) => void;
  onPeerLeft?: (peer: string, reason: string) => void;
  onTransferReady?: (from: string, info: Record<string, unknown>) => void;
  onTransferComplete?: (from: string, info: Record<string, unknown>) => void;
  onErrorMsg?: (code: string, message: string) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<string, { resolve: (v: ServerMessage) => void; reject: (e: Error) => void }>();

  clientId: string | null = null;
  room: string | null = null;

  constructor(
    private readonly url: string,
    private readonly events: SignalingEvents = {},
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => {
        this.events.onOpen?.();
        resolve();
      };
      ws.onerror = () => reject(new Error("signaling connection failed"));
      ws.onclose = () => this.events.onClose?.();
      ws.onmessage = (ev) => this.handle(String(ev.data));
    });
  }

  private handle(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    if (msg.type === "WELCOME") {
      this.clientId = msg.clientId;
      return;
    }
    const reqId = (msg as { requestId?: string }).requestId;
    if (reqId && this.pending.has(reqId)) {
      this.pending.get(reqId)!.resolve(msg);
      this.pending.delete(reqId);
    }
    switch (msg.type) {
      case "JOINED":
        this.room = msg.room;
        this.events.onPeers?.(msg.peers);
        break;
      case "PEER_JOINED":
        this.events.onPeerJoined?.(msg.peer);
        break;
      case "OFFER":
        this.events.onOffer?.(msg.from, msg.sdp);
        break;
      case "ANSWER":
        this.events.onAnswer?.(msg.from, msg.sdp);
        break;
      case "ICE_CANDIDATE":
        this.events.onIce?.(msg.from, msg.candidate);
        break;
      case "PEER_LEFT":
        this.events.onPeerLeft?.(msg.peer, msg.reason);
        break;
      case "TRANSFER_READY":
        this.events.onTransferReady?.(msg.from, msg as unknown as Record<string, unknown>);
        break;
      case "TRANSFER_COMPLETE":
        this.events.onTransferComplete?.(msg.from, msg as unknown as Record<string, unknown>);
        break;
      case "ERROR":
        this.events.onErrorMsg?.(msg.code, msg.message);
        break;
      default:
        break;
    }
  }

  private send(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("signaling socket not open");
    }
    this.ws.send(JSON.stringify(msg));
  }

  /** Send + wait for the correlated ack (ROOM_CREATED / JOINED / ERROR). */
  private request<T extends ServerMessage>(msg: ClientMessage): Promise<T> {
    const requestId = `r${++this.seq}`;
    (msg as Record<string, unknown>).requestId = requestId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("signaling request timed out"));
      }, 8000);
      this.pending.set(requestId, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.send(msg);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  createRoom(opts: { maxPeers?: number; ttlSec?: number } = {}): Promise<{ room: string; expiresAt: number }> {
    return this.request<ServerMessage>({
      type: "CREATE_ROOM",
      ...opts,
    }).then((m) => {
      if (m.type === "ERROR") throw new Error(`${m.code}: ${m.message}`);
      if (m.type !== "ROOM_CREATED") throw new Error(`unexpected reply: ${m.type}`);
      return { room: m.room, expiresAt: m.expiresAt };
    });
  }

  join(room: string, role: Role): Promise<PeerInfo[]> {
    return this.request<ServerMessage>({
      type: "JOIN_ROOM",
      room,
      role,
    }).then((m) => {
      if (m.type === "ERROR") throw new Error(`${m.code}: ${m.message}`);
      if (m.type !== "JOINED") throw new Error(`unexpected reply: ${m.type}`);
      this.room = m.room;
      return m.peers;
    });
  }

  sendOffer(sdp: SdpPayload): void {
    if (!this.room) throw new Error("join a room first");
    this.send({ type: "OFFER", room: this.room, sdp });
  }

  sendAnswer(sdp: SdpPayload): void {
    if (!this.room) throw new Error("join a room first");
    this.send({ type: "ANSWER", room: this.room, sdp });
  }

  sendIce(candidate: IceCandidatePayload): void {
    if (!this.room) throw new Error("join a room first");
    this.send({ type: "ICE_CANDIDATE", room: this.room, candidate });
  }

  announceReady(info: { transferId: string; fileName: string; fileSize: number; chunks: number }): void {
    if (!this.room) throw new Error("join a room first");
    this.send({ type: "TRANSFER_READY", room: this.room, ...info });
  }

  announceComplete(info: { transferId: string }): void {
    if (!this.room) throw new Error("join a room first");
    this.send({ type: "TRANSFER_COMPLETE", room: this.room, ...info });
  }

  leave(): void {
    if (this.room) {
      try {
        this.send({ type: "LEAVE", room: this.room });
      } catch {
        /* socket gone */
      }
      this.room = null;
    }
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
