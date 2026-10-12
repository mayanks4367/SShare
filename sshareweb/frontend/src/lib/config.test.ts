import { describe, expect, it } from "vitest";
import { endpointWarnings } from "@/lib/config";

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
