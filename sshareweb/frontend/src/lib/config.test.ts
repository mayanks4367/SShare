import { describe, expect, it } from "vitest";
import { endpointWarnings, signalingUrl } from "@/lib/config";

describe("endpointWarnings", () => {
  it("stays silent on plain http pages (local dev)", () => {
    expect(
      endpointWarnings({
        pageSecure: false,
        signaling: "ws://localhost:8787/ws",
        gateway: "http://localhost:8080",
      }),
    ).toEqual([]);
  });

  it("warns about ws:// signaling on https pages", () => {
    const warnings = endpointWarnings({
      pageSecure: true,
      signaling: "ws://localhost:8787/ws",
      gateway: null,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/wss:\/\//);
  });

  it("warns about http:// gateway on https pages", () => {
    const warnings = endpointWarnings({
      pageSecure: true,
      signaling: "wss://signal.example.com/ws",
      gateway: "http://localhost:8080",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/gateway/i);
  });

  it("stays silent on consistent secure config", () => {
    expect(
      endpointWarnings({
        pageSecure: true,
        signaling: "wss://signal.example.com/ws",
        gateway: "https://gateway.example.com",
      }),
    ).toEqual([]);
  });
});

describe("signalingUrl", () => {
  it("resolves dynamic host based on window.location", () => {
    const originalLocation = window.location;
    try {
      // @ts-expect-error test mock
      delete window.location;
      // @ts-expect-error test mock
      window.location = {
        hostname: "192.168.1.42",
        protocol: "http:",
      };
      expect(signalingUrl()).toBe("ws://192.168.1.42:8787/ws");

      // @ts-expect-error test mock
      window.location = {
        hostname: "share.example.com",
        protocol: "https:",
      };
      expect(signalingUrl()).toBe("wss://share.example.com:8787/ws");
    } finally {
      window.location = originalLocation;
    }
  });
});
