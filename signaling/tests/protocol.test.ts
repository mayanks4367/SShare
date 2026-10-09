import { describe, it, expect } from "vitest";
import { validateClientMessage } from "../src/protocol.js";

const SDP = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";

describe("protocol validation", () => {
  it("accepts CREATE_ROOM", () => {
    expect(validateClientMessage({ type: "CREATE_ROOM" })).toBeNull();
    expect(validateClientMessage({ type: "CREATE_ROOM", maxPeers: 2, ttlSec: 600 })).toBeNull();
  });

  it("rejects bad CREATE_ROOM options", () => {
    expect(validateClientMessage({ type: "CREATE_ROOM", maxPeers: 99 })).not.toBeNull();
    expect(validateClientMessage({ type: "CREATE_ROOM", ttlSec: 5 })).not.toBeNull();
  });

  it("accepts JOIN/OFFER/ANSWER/ICE", () => {
    expect(validateClientMessage({ type: "JOIN_ROOM", room: "SS-ABC123", role: "sender" })).toBeNull();
    expect(
      validateClientMessage({ type: "OFFER", room: "SS-ABC123", sdp: { type: "offer", sdp: SDP } }),
    ).toBeNull();
    expect(
      validateClientMessage({ type: "ANSWER", room: "SS-ABC123", sdp: { type: "answer", sdp: SDP } }),
    ).toBeNull();
    expect(
      validateClientMessage({
        type: "ICE_CANDIDATE",
        room: "SS-ABC123",
        candidate: { candidate: "candidate:1 1 udp 1 1.2.3.4 5000 typ host" },
      }),
    ).toBeNull();
  });

  it("rejects unknown types, bad rooms, bad roles", () => {
    expect(validateClientMessage({ type: "NOPE" })).not.toBeNull();
    expect(validateClientMessage({ type: "JOIN_ROOM", room: "!!!", role: "sender" })).not.toBeNull();
    expect(validateClientMessage({ type: "JOIN_ROOM", room: "SS-ABC123", role: "spy" })).not.toBeNull();
    expect(validateClientMessage({ type: "OFFER", room: "SS-ABC123", sdp: { type: "offer", sdp: "x" } })).not.toBeNull();
  });

  it("rejects file payload smuggling", () => {
    expect(
      validateClientMessage({ type: "TRANSFER_READY", room: "SS-ABC123", data: "AAAA" }),
    ).not.toBeNull();
    expect(
      validateClientMessage({ type: "OFFER", room: "SS-ABC123", sdp: { type: "offer", sdp: SDP }, chunk: [1] }),
    ).not.toBeNull();
    // ...but metadata headers are fine
    expect(
      validateClientMessage({
        type: "TRANSFER_READY",
        room: "SS-ABC123",
        transferId: "SS-X",
        fileName: "a.bin",
        fileSize: 10,
        chunks: 1,
      }),
    ).toBeNull();
  });

  it("rejects oversized transfer headers", () => {
    expect(
      validateClientMessage({ type: "TRANSFER_READY", room: "SS-ABC123", fileName: "x".repeat(300) }),
    ).not.toBeNull();
  });
});
