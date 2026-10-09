import { describe, it, expect } from "vitest";
import { sanitizeHave, computeRemaining, encodeControl, decodeControl } from "../src/transfer-engine/protocol.js";
import { classifyRoute } from "../src/transfer-engine/peer.js";

describe("resumption hints", () => {
  it("round-trips have messages", () => {
    const raw = encodeControl({ t: "have", transferId: "SS-X", have: [0, 2] });
    expect(decodeControl(raw)).toEqual({ t: "have", transferId: "SS-X", have: [0, 2] });
  });

  it("sanitizes hostile hints and computes the remainder", () => {
    expect(sanitizeHave([0, 2, 2, 99, -1, 1.5], 3)).toEqual([0, 2]);
    expect(sanitizeHave(null, 3)).toEqual([]);
    expect(computeRemaining(4, new Set([0, 2]))).toEqual([1, 3]);
  });
});

describe("route classification", () => {
  it("maps candidate types without addresses", () => {
    expect(classifyRoute(null)).toBe("unknown");
    expect(classifyRoute({ localType: "host", remoteType: "srflx" })).toBe("direct");
    expect(classifyRoute({ localType: "host", remoteType: "relay" })).toBe("relay");
  });
});
