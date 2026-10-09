/**
 * Manual signaling (copy-paste SDP) — smallest possible prototype.
 * No server: offer/answer are base64url strings the user copies between
 * devices. Uses non-trickle ICE (wait for gathering complete) so ONE
 * paste per direction is enough. Interface is pluggable for future WSS.
 */

export interface SignalingCode {
  sdp: RTCSessionDescriptionInit;
}

export function encodeCode(sdp: RTCSessionDescriptionInit): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(sdp)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCode(code: string): RTCSessionDescriptionInit {
  const b64 = code.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(decodeURIComponent(escape(atob(padded))));
}

function waitGatheringComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
    // Safety timeout: resolve after 5s even if still gathering (host candidates work on LAN).
    setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    }, 5000);
  });
}

/** Sender: create offer code to show. Must setLocalDescription first. */
export async function createOfferCode(pc: RTCPeerConnection): Promise<string> {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitGatheringComplete(pc);
  return encodeCode(pc.localDescription!.toJSON());
}

/** Receiver: accept pasted offer, produce answer code. */
export async function acceptOfferAndMakeAnswer(pc: RTCPeerConnection, offerCode: string): Promise<string> {
  const offer = decodeCode(offerCode);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitGatheringComplete(pc);
  return encodeCode(pc.localDescription!.toJSON());
}

/** Sender: accept pasted answer to complete handshake. */
export async function acceptAnswerCode(pc: RTCPeerConnection, answerCode: string): Promise<void> {
  const answer = decodeCode(answerCode);
  await pc.setRemoteDescription(new RTCSessionDescription(answer));
}

/** Pluggable interface for a future WebSocket signaling server. */
export interface SignalingChannel {
  sendOffer(sessionId: string, sdp: RTCSessionDescriptionInit): Promise<void>;
  onOffer(cb: (sessionId: string, sdp: RTCSessionDescriptionInit) => void): void;
  sendAnswer(sessionId: string, sdp: RTCSessionDescriptionInit): Promise<void>;
  onAnswer(cb: (sessionId: string, sdp: RTCSessionDescriptionInit) => void): void;
}
