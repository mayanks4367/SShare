import { afterEach, describe, expect, it } from "vitest";
import {
  customLinkHost,
  isLoopbackBase,
  normalizeRoomCode,
  receiverBaseUrl,
  receiverLink,
  ROOM_CODE_RE,
  setCustomLinkHost,
} from "@/lib/share-link";

describe("share links", () => {
  it("accepts server-shaped room codes, case-insensitively", () => {
    expect(normalizeRoomCode("SS-ABC123")).toBe("SS-ABC123");
    expect(normalizeRoomCode("  ss-abc123  ")).toBe("SS-ABC123");
    expect(ROOM_CODE_RE.test("SS-ABC123")).toBe(true);
  });

  it("rejects empty, malformed and traversal-shaped input", () => {
    expect(normalizeRoomCode(null)).toBeNull();
    expect(normalizeRoomCode("")).toBeNull();
    expect(normalizeRoomCode("  ")).toBeNull();
    expect(normalizeRoomCode("SS-ABC 123")).toBeNull();
    expect(normalizeRoomCode("../secret")).toBeNull();
    expect(normalizeRoomCode("SS-ABC123/extra")).toBeNull();
    expect(normalizeRoomCode("x".repeat(33))).toBeNull();
  });

  it("builds receiver links without double slashes", () => {
    expect(receiverLink("SS-ABC123", "http://192.168.1.5:5173")).toBe(
      "http://192.168.1.5:5173/r/SS-ABC123",
    );
    expect(receiverLink("SS-ABC123", "https://share.example.com/")).toBe(
      "https://share.example.com/r/SS-ABC123",
    );
  });

  it("receiver base URL is a string (env override or origin)", () => {
    expect(typeof receiverBaseUrl()).toBe("string");
  });

  it("detects loopback bases that phones cannot open", () => {
    expect(isLoopbackBase("http://localhost:5173/r/SS-X")).toBe(true);
    expect(isLoopbackBase("http://127.0.0.1:5173/r/SS-X")).toBe(true);
    expect(isLoopbackBase("http://[::1]:5173/r/SS-X")).toBe(true);
    expect(isLoopbackBase("http://192.168.1.5:5173/r/SS-X")).toBe(false);
    expect(isLoopbackBase("https://share.example.com/r/SS-X")).toBe(false);
    expect(isLoopbackBase("not a url")).toBe(false);
  });
});

describe("custom link host override", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("is unset by default and round-trips set/clear", () => {
    expect(customLinkHost()).toBeNull();
    setCustomLinkHost("http://192.168.1.5:5173/");
    expect(customLinkHost()).toBe("http://192.168.1.5:5173");
    expect(receiverBaseUrl()).toBe("http://192.168.1.5:5173");
    expect(receiverLink("SS-ABC123")).toBe("http://192.168.1.5:5173/r/SS-ABC123");
    setCustomLinkHost(null);
    expect(customLinkHost()).toBeNull();
  });

  it("ignores blank values", () => {
    setCustomLinkHost("   ");
    expect(customLinkHost()).toBeNull();
  });
});
