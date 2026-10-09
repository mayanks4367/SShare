/**
 * Peer layer: thin, framework-free wrapper around RTCPeerConnection +
 * one reliable ordered DataChannel. Handles backpressure, progress,
 * speed/ETA, cancellation and connection-state reporting.
 *
 * Design notes for later SShare integration:
 * - All chunk bytes flow through `sendChunkFrame` / `onChunk` so the
 *   Rust/WASM chunker can be swapped under the same interface.
 * - Signaling (SDP exchange) is intentionally OUTSIDE this file;
 *   see `src/signaling/manual.ts`. This class only owns the peer + channel.
 */
import {
  PROTOCOL_CHANNEL,
  assertIncomingMetadata,
  computeRemaining,
  decodeChunk,
  decodeControl,
  encodeChunk,
  encodeControl,
  MAX_CHUNK_FRAME_BYTES,
  sanitizeHave,
} from "./protocol.js";
import { reassembleByIndex } from "./chunker.js";
import { sha256Hex } from "./checksum.js";
import type {
  ConnectionStatus,
  ControlMessage,
  TransferMetadata,
  TransferProgress,
  TransferStatus,
} from "./types.js";

export interface PeerEvents {
  onConnection?: (s: ConnectionStatus) => void;
  onTransfer?: (s: TransferStatus) => void;
  onProgress?: (p: TransferProgress) => void;
  onMetadata?: (m: TransferMetadata) => void;
  onComplete?: (file: Uint8Array, meta: TransferMetadata) => void;
  onError?: (e: Error) => void;
  onCancelled?: (reason?: string) => void;
  onRoute?: (kind: RouteKind, rttMs?: number) => void;
}

/** Tunables; everything has a production default. */
export interface PeerOptions {
  iceServers?: RTCIceServer[];
  /** Give up establishing the connection after this long (ms, 0 = off). */
  connectionTimeoutMs?: number;
  /** DataChannel bufferedAmount pause threshold (bytes). */
  backpressureBytes?: number;
  /** How long a sender waits for a receiver `have` resume hint (ms). */
  resumeWaitMs?: number;
}

export type RouteKind = "direct" | "relay" | "unknown";

/** Classify the selected pair without exposing addresses (pure, tested). */
export function classifyRoute(pair: { localType?: string; remoteType?: string } | null): RouteKind {
  if (!pair) return "unknown";
  const types = [pair.localType ?? "", pair.remoteType ?? ""].map((s) => s.toLowerCase());
  if (types.some((t) => t === "relay")) return "relay";
  if (types.some((t) => t === "host" || t === "srflx" || t === "prflx")) return "direct";
  return "unknown";
}

export interface RouteInfo {
  kind: RouteKind;
  rttMs?: number;
}

export const BACKPRESSURE_BYTES = 1 * 1024 * 1024; // pause sends above 1 MiB buffered
const PROGRESS_THROTTLE_MS = 120;

function rtcStatus(pc: RTCPeerConnection): ConnectionStatus {
  return pc.connectionState as ConnectionStatus;
}

export function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function progressFor(
  transferred: number,
  total: number,
  startedAt: number,
): TransferProgress {
  const elapsed = Math.max(1, nowMs() - startedAt) / 1000;
  const speedBps = transferred / elapsed;
  const percent = total === 0 ? 100 : (transferred / total) * 100;
  const etaSec = speedBps > 0 ? (total - transferred) / speedBps : Infinity;
  return { bytesTransferred: transferred, totalBytes: total, percent, speedBps, etaSec };
}

/** Wait until DataChannel bufferedAmount drains below threshold. */
async function drainBackpressure(
  dc: RTCDataChannel,
  threshold: number,
  cancelled: () => boolean,
  onStall?: () => void,
): Promise<void> {
  if (dc.bufferedAmount <= threshold) return;
  onStall?.();
  await new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const timer = window.setInterval(() => {
      if (cancelled()) {
        window.clearInterval(timer);
        dc.onbufferedamountlow = null;
        reject(new Error("cancelled"));
        return;
      }
      if (dc.bufferedAmount <= threshold || Date.now() - t0 > 30_000) {
        window.clearInterval(timer);
        dc.onbufferedamountlow = null;
        resolve();
      }
    }, 50);
    dc.onbufferedamountlow = () => {
      window.clearInterval(timer);
      dc.onbufferedamountlow = null;
      resolve();
    };
  });
}

export class TransferPeer {
  readonly pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private events: PeerEvents;
  private role: "sender" | "receiver";
  private opts: Required<PeerOptions>;
  private cancelFlag = false;
  private connTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRoute: RouteKind | null = null;
  private haveHints = new Map<string, Set<number>>();
  private haveWaiters = new Map<string, () => void>();

  /** How many times the sender hit backpressure (diagnostics). */
  backpressureStalls = 0;

  // sender state
  private sendMeta: TransferMetadata | null = null;
  private sendStartedAt = 0;
  private sentBytes = 0;

  // receiver state
  private recvMeta: TransferMetadata | null = null;
  private recvChunks: (Uint8Array | undefined)[] = [];
  private recvBytes = 0;
  private recvStartedAt = 0;
  private lastProgressEmit = 0;

  constructor(role: "sender" | "receiver", events: PeerEvents = {}, opts: PeerOptions = {}) {
    this.role = role;
    this.events = events;
    this.opts = {
      iceServers: opts.iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }],
      connectionTimeoutMs: opts.connectionTimeoutMs ?? 0,
      backpressureBytes: opts.backpressureBytes ?? BACKPRESSURE_BYTES,
      resumeWaitMs: opts.resumeWaitMs ?? 1500,
    };
    this.pc = new RTCPeerConnection({ iceServers: this.opts.iceServers });
    this.pc.onconnectionstatechange = () => {
      const s = rtcStatus(this.pc);
      this.events.onConnection?.(s);
      if (s === "connected") this.clearConnectionTimeout();
      if (this.pc.connectionState === "failed") {
        this.events.onError?.(new Error("peer connection failed (NAT? relay may be needed)"));
      }
    };
    if (role === "sender") {
      this.dc = this.pc.createDataChannel(PROTOCOL_CHANNEL, {
        ordered: true, // reliable + ordered: file integrity first
      });
      this.attachChannel(this.dc);
    } else {
      this.pc.ondatachannel = (ev) => {
        this.dc = ev.channel;
        this.attachChannel(this.dc);
      };
    }
  }

  get channel(): RTCDataChannel | null {
    return this.dc;
  }

  channelOpen(): boolean {
    return !!this.dc && this.dc.readyState === "open";
  }

  /** Watchdog: report a timeout if `connected` is never reached. */
  armConnectionTimeout(ms?: number): void {
    this.clearConnectionTimeout();
    const budget = ms ?? this.opts.connectionTimeoutMs;
    if (!budget || budget <= 0) return;
    this.connTimer = setTimeout(() => {
      this.connTimer = null;
      if (this.pc.connectionState !== "connected") {
        this.events.onError?.(
          new Error(
            `connection timed out after ${Math.round(budget / 1000)}s (no direct or relay path established)`,
          ),
        );
      }
    }, budget);
  }

  clearConnectionTimeout(): void {
    if (this.connTimer) {
      clearTimeout(this.connTimer as unknown as number);
      this.connTimer = null;
    }
  }

  /** Selected ICE pair kind + RTT only — never addresses. */
  async getRouteInfo(): Promise<RouteInfo> {
    try {
      const stats = await this.pc.getStats();
      const found: Array<{ localType?: string; remoteType?: string; rtt?: number }> = [];
      const remotes = new Map<string, string>();
      const locals = new Map<string, string>();
      stats.forEach((r) => {
        const rec = r as unknown as Record<string, unknown>;
        if (rec["type"] === "remote-candidate" && typeof rec["id"] === "string") {
          remotes.set(rec["id"] as string, String(rec["candidateType"] ?? ""));
        } else if (rec["type"] === "local-candidate" && typeof rec["id"] === "string") {
          locals.set(rec["id"] as string, String(rec["candidateType"] ?? ""));
        }
      });
      stats.forEach((r) => {
        const rec = r as unknown as Record<string, unknown>;
        const isPair = rec["type"] === "candidate-pair" || rec["type"] === "candidatepair";
        if (!isPair || found.length > 0) return;
        const sel = rec["selected"] === true || rec["nominated"] === true;
        const usable = sel || (rec["writable"] === true && rec["state"] === "succeeded");
        if (!usable) return;
        found.push({
          localType: locals.get(String(rec["localCandidateId"] ?? "")),
          remoteType: remotes.get(String(rec["remoteCandidateId"] ?? "")),
          rtt:
            typeof rec["currentRoundTripTime"] === "number"
              ? (rec["currentRoundTripTime"] as number) * 1000
              : undefined,
        });
      });
      const selected = found[0];
      if (!selected) return { kind: "unknown" };
      const kind = classifyRoute(selected);
      const info: RouteInfo = { kind };
      if (typeof selected.rtt === "number" && Number.isFinite(selected.rtt)) {
        info.rttMs = Math.round(selected.rtt);
      }
      if (kind !== this.lastRoute) {
        this.lastRoute = kind;
        this.events.onRoute?.(kind, info.rttMs);
      }
      return info;
    } catch {
      return { kind: "unknown" };
    }
  }

  private attachChannel(dc: RTCDataChannel): void {
    dc.binaryType = "arraybuffer";
    dc.onopen = () => {
      this.events.onConnection?.(rtcStatus(this.pc));
      if (this.role === "sender") {
        this.events.onTransfer?.("idle"); // ready to send
      } else {
        this.events.onTransfer?.("waiting-channel");
      }
    };
    dc.onclose = () => this.events.onConnection?.("closed");
    dc.onerror = () => this.events.onError?.(new Error("data channel error"));
    dc.onmessage = (ev) => {
      void this.handleMessage(ev.data).catch((e) =>
        this.events.onError?.(e instanceof Error ? e : new Error(String(e))),
      );
    };
  }

  private async handleMessage(data: string | ArrayBuffer): Promise<void> {
    if (typeof data === "string") {
      const msg = decodeControl(data);
      await this.handleControl(msg);
    } else {
      this.handleChunkFrame(data);
    }
  }

  private async handleControl(msg: ControlMessage): Promise<void> {
    if (msg.t === "meta" && this.role === "receiver") {
      let meta: TransferMetadata;
      try {
        meta = assertIncomingMetadata(msg.meta);
      } catch (e) {
        this.events.onTransfer?.("error");
        this.events.onError?.(e instanceof Error ? e : new Error("rejected malicious manifest"));
        return;
      }
      if (this.recvMeta && this.recvMeta.transferId === meta.transferId && this.recvBytes > 0) {
        const have: number[] = [];
        for (let i = 0; i < this.recvChunks.length; i++) {
          if (this.recvChunks[i]) have.push(i);
        }
        this.dc?.send(encodeControl({ t: "have", transferId: meta.transferId, have }));
        this.events.onTransfer?.("receiving");
        this.emitProgressRecv(true);
        return;
      }
      this.recvMeta = meta;
      this.recvChunks = new Array(meta.totalChunks).fill(undefined);
      this.recvBytes = 0;
      this.recvStartedAt = nowMs();
      this.events.onMetadata?.(meta);
      this.events.onTransfer?.("receiving");
      this.emitProgressRecv(true);
    } else if (msg.t === "have" && this.role === "sender") {
      const set = this.haveHints.get(msg.transferId) ?? new Set<number>();
      for (const i of sanitizeHave(msg.have, 1_000_000)) set.add(i);
      this.haveHints.set(msg.transferId, set);
      const wake = this.haveWaiters.get(msg.transferId);
      if (wake) {
        this.haveWaiters.delete(msg.transferId);
        wake();
      }
    } else if (msg.t === "done" && this.role === "receiver") {
      if (!this.recvMeta || msg.transferId !== this.recvMeta.transferId) return;
      await this.finishReceive();
    } else if (msg.t === "cancel") {
      const active = this.sendMeta?.transferId ?? this.recvMeta?.transferId ?? "";
      if (!active || msg.transferId !== active) return;
      this.events.onTransfer?.("cancelled");
      this.events.onCancelled?.(msg.reason);
    } else if (msg.t === "error") {
      const active = this.sendMeta?.transferId ?? this.recvMeta?.transferId ?? "";
      if (!active || msg.transferId !== active) return;
      this.events.onTransfer?.("error");
      this.events.onError?.(new Error(msg.message));
    }
  }

  private handleChunkFrame(buf: ArrayBuffer): void {
    if (this.role !== "receiver" || !this.recvMeta) return;
    if (buf.byteLength > MAX_CHUNK_FRAME_BYTES) return;
    const { index, payload } = decodeChunk(buf);
    if (index >= this.recvMeta.totalChunks) return;
    if (payload.length > this.recvMeta.chunkSize) return;
    if (this.recvBytes + payload.length > this.recvMeta.fileSize) {
      this.events.onTransfer?.("error");
      this.events.onError?.(new Error("peer sent more bytes than the manifest declares"));
      return;
    }
    if (!this.recvChunks[index]) {
      this.recvChunks[index] = payload;
      this.recvBytes += payload.length;
    }
    this.emitProgressRecv(false);
  }

  private emitProgressRecv(force: boolean): void {
    if (!this.recvMeta) return;
    const t = Date.now();
    if (!force && t - this.lastProgressEmit < PROGRESS_THROTTLE_MS) return;
    this.lastProgressEmit = t;
    this.events.onProgress?.(
      progressFor(this.recvBytes, this.recvMeta.fileSize, this.recvStartedAt),
    );
  }

  private async finishReceive(): Promise<void> {
    if (!this.recvMeta) throw new Error("done before metadata");
    this.events.onTransfer?.("verifying");
    const file = reassembleByIndex(this.recvChunks, this.recvMeta.totalChunks, this.recvMeta.fileSize);
    const sum = await sha256Hex(file);
    if (sum !== this.recvMeta.checksum) {
      this.events.onTransfer?.("error");
      this.events.onError?.(
        new Error(`checksum mismatch: expected ${this.recvMeta.checksum.slice(0, 16)}…, got ${sum.slice(0, 16)}… (file corrupted)`),
      );
      return;
    }
    this.events.onProgress?.(
      progressFor(this.recvMeta.fileSize, this.recvMeta.fileSize, this.recvStartedAt),
    );
    this.events.onTransfer?.("complete");
    this.events.onComplete?.(file, this.recvMeta);
  }

  /**
   * Sender: stream a Blob/File chunk-by-chunk over the open channel.
   * Reads sequentially (low RAM), respects backpressure, emits progress.
   * Briefly waits for a receiver `have` hint after `meta` so interrupted
   * transfers resume instead of restarting.
   */
  async sendFile(meta: TransferMetadata, blob: Blob): Promise<void> {
    if (this.role !== "sender") throw new Error("only sender can sendFile");
    if (!this.channelOpen()) throw new Error("data channel not open yet");
    this.cancelFlag = false;
    this.sendMeta = meta;
    this.sendStartedAt = nowMs();
    this.events.onTransfer?.("sending");

    this.dc!.send(encodeControl({ t: "meta", meta }));
    await this.awaitHaveHint(meta.transferId);

    const skip = this.haveHints.get(meta.transferId) ?? new Set<number>();
    const order = computeRemaining(meta.totalChunks, skip);
    this.sentBytes = meta.fileSize - orderByteLength(meta, order);
    this.events.onProgress?.(progressFor(this.sentBytes, meta.fileSize, this.sendStartedAt));

    let lastEmit = 0;
    for (const index of order) {
      if (this.cancelFlag) {
        this.dc!.send(encodeControl({ t: "cancel", transferId: meta.transferId, reason: "sender cancelled" }));
        this.events.onTransfer?.("cancelled");
        this.events.onCancelled?.("sender cancelled");
        return;
      }
      if (!this.channelOpen()) {
        throw new Error("data channel closed mid-transfer (peer disconnected?)");
      }
      const start = index * meta.chunkSize;
      const slice = blob.slice(start, start + meta.chunkSize);
      const payload = new Uint8Array(await slice.arrayBuffer());
      await drainBackpressure(this.dc!, this.opts.backpressureBytes, () => this.cancelFlag, () => {
        this.backpressureStalls += 1;
      });
      this.dc!.send(encodeChunk(index, payload));
      this.sentBytes += payload.length;
      const t = Date.now();
      if (t - lastEmit >= PROGRESS_THROTTLE_MS || index === order[order.length - 1]) {
        lastEmit = t;
        this.events.onProgress?.(progressFor(this.sentBytes, meta.fileSize, this.sendStartedAt));
      }
    }
    this.haveHints.delete(meta.transferId);
    this.dc!.send(encodeControl({ t: "done", transferId: meta.transferId }));
    this.events.onProgress?.(progressFor(meta.fileSize, meta.fileSize, this.sendStartedAt));
    this.events.onTransfer?.("complete");
  }

  /** Wait for a `have` hint, but never longer than resumeWaitMs. */
  private awaitHaveHint(transferId: string): Promise<void> {
    if (this.haveHints.has(transferId)) return Promise.resolve();
    const budget = this.opts.resumeWaitMs;
    if (!budget || budget <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.haveWaiters.delete(transferId);
        resolve();
      }, budget);
      this.haveWaiters.set(transferId, () => {
        clearTimeout(timer as unknown as number);
        resolve();
      });
    });
  }

  cancel(reason = "cancelled"): void {
    this.cancelFlag = true;
    try {
      const id = this.sendMeta?.transferId ?? this.recvMeta?.transferId ?? "";
      if (this.channelOpen() && id) {
        this.dc!.send(encodeControl({ t: "cancel", transferId: id, reason }));
      }
    } catch {
      /* channel already gone */
    }
    this.events.onTransfer?.("cancelled");
    this.events.onCancelled?.(reason);
  }

  close(): void {
    this.clearConnectionTimeout();
    try {
      this.dc?.close();
    } catch {
      /* ignore */
    }
    this.pc.close();
  }
}

/** Byte length covered by an ordered index list under this manifest. */
function orderByteLength(meta: TransferMetadata, order: number[]): number {
  let n = 0;
  for (const i of order) {
    n += Math.min(meta.chunkSize, meta.fileSize - i * meta.chunkSize);
  }
  return n;
}

/** Receiver helper: turn verified bytes into a downloadable object URL. */
export function toDownloadUrl(file: Uint8Array, mimeType: string): string {
  const blob = new Blob([file.buffer as ArrayBuffer], { type: mimeType });
  return URL.createObjectURL(blob);
}
