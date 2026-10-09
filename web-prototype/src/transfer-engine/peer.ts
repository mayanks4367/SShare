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
  decodeChunk,
  decodeControl,
  encodeChunk,
  encodeControl,
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
  cancelled: () => boolean,
): Promise<void> {
  if (dc.bufferedAmount <= BACKPRESSURE_BYTES) return;
  await new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const timer = window.setInterval(() => {
      if (cancelled()) {
        window.clearInterval(timer);
        dc.onbufferedamountlow = null;
        reject(new Error("cancelled"));
        return;
      }
      if (dc.bufferedAmount <= BACKPRESSURE_BYTES || Date.now() - t0 > 30_000) {
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
  private cancelFlag = false;

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

  constructor(role: "sender" | "receiver", events: PeerEvents = {}) {
    this.role = role;
    this.events = events;
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    this.pc.onconnectionstatechange = () => {
      this.events.onConnection?.(rtcStatus(this.pc));
      if (this.pc.connectionState === "failed") {
        this.events.onError?.(new Error("peer connection failed (NAT? try same network)"));
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
      this.recvMeta = msg.meta;
      this.recvChunks = new Array(msg.meta.totalChunks).fill(undefined);
      this.recvBytes = 0;
      this.recvStartedAt = nowMs();
      this.events.onMetadata?.(msg.meta);
      this.events.onTransfer?.("receiving");
      this.emitProgressRecv(true);
    } else if (msg.t === "done" && this.role === "receiver") {
      await this.finishReceive();
    } else if (msg.t === "cancel") {
      this.events.onTransfer?.("cancelled");
      this.events.onCancelled?.(msg.reason);
    } else if (msg.t === "error") {
      this.events.onTransfer?.("error");
      this.events.onError?.(new Error(msg.message));
    }
  }

  private handleChunkFrame(buf: ArrayBuffer): void {
    if (this.role !== "receiver" || !this.recvMeta) return;
    const { index, payload } = decodeChunk(buf);
    if (index >= this.recvMeta.totalChunks) return;
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
   */
  async sendFile(meta: TransferMetadata, blob: Blob): Promise<void> {
    if (this.role !== "sender") throw new Error("only sender can sendFile");
    if (!this.channelOpen()) throw new Error("data channel not open yet");
    this.cancelFlag = false;
    this.sendMeta = meta;
    this.sentBytes = 0;
    this.sendStartedAt = nowMs();
    this.events.onTransfer?.("sending");

    this.dc!.send(encodeControl({ t: "meta", meta }));
    let lastEmit = 0;
    for (let index = 0; index < meta.totalChunks; index++) {
      if (this.cancelFlag) {
        this.dc!.send(encodeControl({ t: "cancel", transferId: meta.transferId, reason: "sender cancelled" }));
        this.events.onTransfer?.("cancelled");
        this.events.onCancelled?.("sender cancelled");
        return;
      }
      const start = index * meta.chunkSize;
      const slice = blob.slice(start, start + meta.chunkSize);
      const payload = new Uint8Array(await slice.arrayBuffer());
      await drainBackpressure(this.dc!, () => this.cancelFlag);
      this.dc!.send(encodeChunk(index, payload));
      this.sentBytes += payload.length;
      const t = Date.now();
      if (t - lastEmit >= PROGRESS_THROTTLE_MS || index === meta.totalChunks - 1) {
        lastEmit = t;
        this.events.onProgress?.(progressFor(this.sentBytes, meta.fileSize, this.sendStartedAt));
      }
    }
    this.dc!.send(encodeControl({ t: "done", transferId: meta.transferId }));
    this.events.onProgress?.(progressFor(meta.fileSize, meta.fileSize, this.sendStartedAt));
    this.events.onTransfer?.("complete");
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
    try {
      this.dc?.close();
    } catch {
      /* ignore */
    }
    this.pc.close();
  }
}

/** Receiver helper: turn verified bytes into a downloadable object URL. */
export function toDownloadUrl(file: Uint8Array, mimeType: string): string {
  const blob = new Blob([file.buffer as ArrayBuffer], { type: mimeType });
  return URL.createObjectURL(blob);
}
