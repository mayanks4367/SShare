/**
 * WebSocket signaling adapter (WSS rooms) — alternative to manual.ts
 * copy-paste codes. Speaks the `signaling/PROTOCOL.md` v1 protocol by
 * reusing `signaling/src/client.ts` (single implementation, no duplication).
 *
 * This file is the ONLY bridge between the web app and the signaling
 * service. The transfer engine (`transfer-engine/`) is untouched: it keeps
 * receiving SDP/ICE through these callbacks and pushing bytes over the
 * DataChannel. File bytes never go through here.
 *
 * Usage:
 *   const sig = new WsTransferSignaling("ws://localhost:8787/ws", {...});
 *   await sig.connect();
 *   const { room } = await sig.createRoom();   // share `room` with peer
 *   await sig.join(room, "sender");
 *   wireTrickleIce(pc, sig);                   // forward local ICE candidates
 *   // onOffer/onAnswer/onIce callbacks drive pc.setRemoteDescription etc.
 */
import { SignalingClient, type SignalingEvents } from "../../../signaling/src/client.js";
import type { IceCandidatePayload, Role } from "../../../signaling/src/protocol.js";

export type { Role };
export type { SignalingEvents };

export class WsTransferSignaling {
  readonly client: SignalingClient;

  constructor(url: string, events: SignalingEvents = {}) {
    this.client = new SignalingClient(url, events);
  }

  connect(): Promise<void> {
    return this.client.connect();
  }

  createRoom(opts: { maxPeers?: number; ttlSec?: number } = {}): Promise<{ room: string; expiresAt: number }> {
    return this.client.createRoom(opts);
  }

  join(room: string, role: Role): ReturnType<SignalingClient["join"]> {
    return this.client.join(room, role);
  }

  sendOffer(sdp: RTCSessionDescriptionInit): void {
    this.client.sendOffer({ type: lower(sdp.type), sdp: sdp.sdp ?? "" });
  }

  sendAnswer(sdp: RTCSessionDescriptionInit): void {
    this.client.sendAnswer({ type: lower(sdp.type), sdp: sdp.sdp ?? "" });
  }

  announceReady(info: { transferId: string; fileName: string; fileSize: number; chunks: number }): void {
    this.client.announceReady(info);
  }

  announceComplete(transferId: string): void {
    this.client.announceComplete({ transferId });
  }

  leave(): void {
    this.client.leave();
  }

  close(): void {
    this.client.close();
  }
}

function lower(t: string | undefined): "offer" | "answer" {
  if (t === "answer") return "answer";
  return "offer";
}

/**
 * Forward locally-gathered ICE candidates to the room (trickle ICE).
 * Remote candidates arriving via onIce should be applied with
 * `pc.addIceCandidate(new RTCIceCandidate(c))` by the caller.
 */
export function wireTrickleIce(pc: RTCPeerConnection, sig: WsTransferSignaling): void {
  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    const payload: IceCandidatePayload = {
      candidate: ev.candidate.candidate,
      sdpMid: ev.candidate.sdpMid,
      sdpMLineIndex: ev.candidate.sdpMLineIndex,
    };
    try {
      sig.client.sendIce(payload);
    } catch {
      /* room not joined yet — caller should join first */
    }
  };
}
