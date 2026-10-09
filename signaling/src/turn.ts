/**
 * Short-lived TURN credentials (coturn `use-auth-secret` REST style).
 *
 * The shared secret NEVER leaves the server: clients POST /api/turn-creds
 * and receive a time-boxed username/password pair. Username embeds the
 * expiry (`<unix-expiry>:<random>`); password is base64(HMAC-SHA1(secret,
 * username)). coturn recomputes the same password from its own copy of the
 * secret, so no credential database is needed.
 */
import { createHmac, randomBytes } from "node:crypto";

export interface TurnIssuerOptions {
  /** URLs to hand out, e.g. ["turn:turn.example.com:3478?transport=udp"]. */
  urls: string[];
  /** Credential lifetime in seconds (clamped 5 min .. 24 h). */
  ttlSec?: number;
}

export interface TurnCredentials {
  urls: string[];
  username: string;
  password: string;
  /** Lifetime in seconds from issuance. */
  ttl: number;
}

export const TURN_TTL_MIN_SEC = 5 * 60;
export const TURN_TTL_MAX_SEC = 24 * 3600;
export const DEFAULT_TURN_TTL_SEC = 3600;

export function clampTurnTtl(ttlSec: number | undefined): number {
  if (!Number.isFinite(ttlSec as number)) return DEFAULT_TURN_TTL_SEC;
  return Math.min(TURN_TTL_MAX_SEC, Math.max(TURN_TTL_MIN_SEC, Math.floor(ttlSec as number)));
}

/** Mint one credential pair. Pure function — unit-tested independently. */
export function mintTurnCredentials(
  secret: string,
  opts: TurnIssuerOptions,
  nowSec: number = Math.floor(Date.now() / 1000),
): TurnCredentials {
  if (!secret) throw new Error("TURN secret is required");
  const ttl = clampTurnTtl(opts.ttlSec);
  const username = `${nowSec + ttl}:${randomBytes(8).toString("hex")}`;
  const password = createHmac("sha1", secret).update(username).digest("base64");
  return { urls: [...opts.urls], username, password, ttl };
}

/** Verify a credential the way coturn would (recompute + check expiry). */
export function verifyTurnCredentials(
  secret: string,
  creds: Pick<TurnCredentials, "username" | "password">,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  const [expiryRaw] = creds.username.split(":");
  const expiry = Number(expiryRaw);
  if (!Number.isFinite(expiry) || expiry <= nowSec) return false;
  const expect = createHmac("sha1", secret).update(creds.username).digest("base64");
  return expect === creds.password;
}

/** Fixed-window per-IP limiter for the credential endpoint. */
export class TurnIpLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly maxPerWindow: number = 20,
    private readonly windowMs: number = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  tryConsume(ip: string): boolean {
    const t = this.now();
    const arr = (this.hits.get(ip) ?? []).filter((s) => s > t - this.windowMs);
    if (arr.length >= this.maxPerWindow) {
      this.hits.set(ip, arr);
      return false;
    }
    arr.push(t);
    this.hits.set(ip, arr);
    return true;
  }
}

/** Resolve TURN settings from options first, environment second. */
export function resolveTurnSettings(opts: {
  turnSecret?: string;
  turnUrls?: string[];
  turnTtlSec?: number;
}): { secret: string; urls: string[]; ttlSec: number } {
  const secret = opts.turnSecret ?? process.env.TURN_SECRET ?? "";
  const urlsRaw = opts.turnUrls ?? (process.env.TURN_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { secret, urls: urlsRaw, ttlSec: clampTurnTtl(opts.turnTtlSec ?? Number(process.env.TURN_TTL_SEC)) };
}
