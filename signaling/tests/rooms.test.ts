import { describe, it, expect } from "vitest";
import { RoomManager, RoomError } from "../src/rooms.js";

describe("RoomManager", () => {
  it("creates rooms with unique ids", () => {
    const m = new RoomManager();
    const a = m.createRoom({ maxPeers: 2, ttlMs: 60_000 });
    const b = m.createRoom({ maxPeers: 2, ttlMs: 60_000 });
    expect(a.id).not.toBe(b.id);
    expect(m.size).toBe(2);
  });

  it("joins peers and lists existing peers for discovery", () => {
    const m = new RoomManager();
    const room = m.createRoom({ maxPeers: 2, ttlMs: 60_000 });
    const j1 = m.joinRoom(room.id, "c1", "sender");
    expect(j1.peers).toEqual([]);
    const j2 = m.joinRoom(room.id, "c2", "receiver");
    expect(j2.peers).toEqual([{ clientId: "c1", role: "sender" }]);
  });

  it("rejects joins over capacity (ROOM_FULL)", () => {
    const m = new RoomManager();
    const room = m.createRoom({ maxPeers: 2, ttlMs: 60_000 });
    m.joinRoom(room.id, "c1", "sender");
    m.joinRoom(room.id, "c2", "receiver");
    expect(() => m.joinRoom(room.id, "c3", "receiver")).toThrowError(RoomError);
    try {
      m.joinRoom(room.id, "c3", "receiver");
    } catch (e) {
      expect((e as RoomError).code).toBe("ROOM_FULL");
    }
  });

  it("rejects unknown rooms (ROOM_NOT_FOUND)", () => {
    const m = new RoomManager();
    expect(() => m.joinRoom("SS-NOPE01", "c1", "sender")).toThrowError(/not found/);
  });

  it("removes empty rooms on last leave", () => {
    const m = new RoomManager();
    const room = m.createRoom({ maxPeers: 2, ttlMs: 60_000 });
    m.joinRoom(room.id, "c1", "sender");
    const left = m.leaveRoom("c1");
    expect(left?.emptied).toBe(true);
    expect(m.size).toBe(0);
  });

  it("expires inactive rooms", () => {
    let t = 0;
    const m = new RoomManager(() => t);
    const room = m.createRoom({ maxPeers: 2, ttlMs: 1000 });
    t += 1001;
    expect(() => m.joinRoom(room.id, "c1", "sender")).toThrowError(RoomError);
    // joinRoom on expired room deletes it
    expect(m.size).toBe(0);
  });

  it("sweepExpired removes only expired rooms", () => {
    let t = 0;
    const m = new RoomManager(() => t);
    const a = m.createRoom({ maxPeers: 2, ttlMs: 500 });
    const b = m.createRoom({ maxPeers: 2, ttlMs: 10_000 });
    t += 600;
    expect(m.sweepExpired()).toEqual([a.id]);
    expect(m.getRoom(b.id)).toBeDefined();
  });
});
