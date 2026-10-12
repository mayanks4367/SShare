/**
 * Minimal signaling client for the SShare signaling service
 * (`signaling/PROTOCOL.md` v1). Browser-native WebSocket, no dependencies.
 *
 * Carries ONLY session setup (rooms, SDP, ICE, transfer headers).
 * File bytes never pass through here — they go over the WebRTC DataChannel.
 */

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

type ServerMessage = { type: string; requestId?: string } & { [key: string]: unknown };

function wStr(m: { [key: string]: unknown }, key: string): string | undefined {
  const v = m[key];
  return typeof v === "string" ? v : undefined;
}

function wNum(m: { [key: string]: unknown }, key: string): number | undefined {
  const v = m[key];
  return typeof v === "number" ? v : undefined;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<
    string,
    { resolve: (v: ServerMessage) => void; reject: (e: Error) => void }
  >();

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
      ws.onmessage = (ev: MessageEvent) => this.handle(String(ev.data));
    });
  }

  /**
   * Connect with bounded retries (1s/2s/4s backoff). Transient failures
   * (server restarting, brief network blip) recover without user action;
   * persistent failure rejects for the caller to report. `isCurrent`
   * aborts retired runs (e.g. user cancelled mid-retry).
   */
  async connectWithRetry(
    opts: {
      attempts?: number;
      baseDelayMs?: number;
      isCurrent?: () => boolean;
      onAttempt?: (n: number, max: number) => void;
    } = {},
  ): Promise<void> {
    const max = Math.max(1, opts.attempts ?? 3);
    const base = Math.max(100, opts.baseDelayMs ?? 1000);
    let lastError: unknown = new Error("signaling connection failed");
    for (let n = 1; n <= max; n++) {
      if (opts.isCurrent && !opts.isCurrent()) throw new Error("cancelled");
      opts.onAttempt?.(n, max);
      try {
        await this.connect();
        return;
      } catch (e) {
        lastError = e;
        try {
          this.close();
        } catch {
          /* ignore */
        }
        if (n === max || (opts.isCurrent && !opts.isCurrent())) break;
        await new Promise((r) => setTimeout(r, base * 2 ** (n - 1)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("signaling connection failed");
  }

  private handle(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    if (msg.type === "WELCOME") {
      const id = wStr(msg, "clientId");
      if (id) this.clientId = id;
      return;
    }
    const requestId = wStr(msg, "requestId");
    if (requestId && this.pending.has(requestId)) {
      const p = this.pending.get(requestId);
      if (p) {
        this.pending.delete(requestId);
        p.resolve(msg);
      }
    }
    switch (msg.type) {
      case "JOINED": {
        const room = wStr(msg, "room");
        if (room) this.room = room;
        if (Array.isArray(msg["peers"])) this.events.onPeers?.(msg["peers"] as PeerInfo[]);
        break;
      }
      case "PEER_JOINED":
        this.events.onPeerJoined?.(msg["peer"] as PeerInfo);
        break;
      case "OFFER":
        this.events.onOffer?.(wStr(msg, "from") ?? "", msg["sdp"] as SdpPayload);
        break;
      case "ANSWER":
        this.events.onAnswer?.(wStr(msg, "from") ?? "", msg["sdp"] as SdpPayload);
        break;
      case "ICE_CANDIDATE":
        this.events.onIce?.(wStr(msg, "from") ?? "", msg["candidate"] as IceCandidatePayload);
        break;
      case "PEER_LEFT":
        this.events.onPeerLeft?.(wStr(msg, "peer") ?? "", wStr(msg, "reason") ?? "");
        break;
      case "TRANSFER_READY":
        this.events.onTransferReady?.(wStr(msg, "from") ?? "", msg);
        break;
      case "TRANSFER_COMPLETE":
        this.events.onTransferComplete?.(wStr(msg, "from") ?? "", msg);
        break;
      case "ERROR":
        this.events.onErrorMsg?.(wStr(msg, "code") ?? "UNKNOWN", wStr(msg, "message") ?? "");
        break;
      default:
        break;
    }
  }

  private send(obj: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("signaling socket not open");
    }
    this.ws.send(JSON.stringify(obj));
  }

  private request(msg: Record<string, unknown>): Promise<ServerMessage> {
    const requestId = `r${++this.seq}`;
    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("signaling request timed out"));
      }, 8000);
      this.pending.set(requestId, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.send({ ...msg, requestId });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private static assertOk(m: ServerMessage, want: string): ServerMessage {
    if (m.type === "ERROR") {
      throw new Error(`${wStr(m, "code") ?? "ERROR"}: ${wStr(m, "message") ?? ""}`);
    }
    if (m.type !== want) throw new Error(`unexpected reply: ${m.type}`);
    return m;
  }

  async createRoom(opts: { maxPeers?: number; ttlSec?: number } = {}): Promise<{
    room: string;
    expiresAt: number;
  }> {
    const m = SignalingClient.assertOk(
      await this.request({ type: "CREATE_ROOM", ...opts }),
      "ROOM_CREATED",
    );
    const room = wStr(m, "room");
    const expiresAt = wNum(m, "expiresAt");
    if (room === undefined || expiresAt === undefined) {
      throw new Error("malformed ROOM_CREATED");
    }
    return { room, expiresAt };
  }

  async join(room: string, role: Role): Promise<PeerInfo[]> {
    const m = SignalingClient.assertOk(
      await this.request({ type: "JOIN_ROOM", room, role }),
      "JOINED",
    );
    const joinedRoom = wStr(m, "room");
    const peers = m["peers"];
    if (joinedRoom === undefined || !Array.isArray(peers)) {
      throw new Error("malformed JOINED");
    }
    this.room = joinedRoom;
    return peers as PeerInfo[];
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

  announceReady(info: {
    transferId: string;
    fileName: string;
    fileSize: number;
    chunks: number;
  }): void {
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
