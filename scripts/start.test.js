import { test } from "node:test";
import assert from "node:assert";
import { getLanIp } from "./start.js";

test("getLanIp returns an IPv4 address", () => {
  const ip = getLanIp();
  assert.ok(typeof ip === "string");
  assert.match(ip, /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  assert.notStrictEqual(ip, "0.0.0.0");
});
