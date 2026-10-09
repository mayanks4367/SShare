import { describe, it, expect } from "vitest";
import { RateLimiter, CreateRoomLimiter } from "../src/rateLimiter.js";

describe("RateLimiter", () => {
  it("allows bursts up to capacity then limits", () => {
    let t = 1000;
    const l = new RateLimiter({ capacity: 3, refillPerSec: 1 }, () => t);
    expect(l.tryConsume()).toBe(true);
    expect(l.tryConsume()).toBe(true);
    expect(l.tryConsume()).toBe(true);
    expect(l.tryConsume()).toBe(false);
    t += 1100; // ~1 token refilled
    expect(l.tryConsume()).toBe(true);
    expect(l.tryConsume()).toBe(false);
  });
});

describe("CreateRoomLimiter", () => {
  it("caps creations per window", () => {
    let t = 0;
    const l = new CreateRoomLimiter(2, 1000, () => t);
    expect(l.tryConsume()).toBe(true);
    expect(l.tryConsume()).toBe(true);
    expect(l.tryConsume()).toBe(false);
    t += 1001;
    expect(l.tryConsume()).toBe(true);
  });
});
