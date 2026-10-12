/**
 * Network configuration for WebRTC: STUN/TURN servers, timeouts,
 * backpressure. No secrets live here — TURN credentials are minted at
 * runtime by the signaling service (POST /api/turn-creds) and live only
 * in memory.
 */

export interface TurnGrant {
  urls: string[];
  username: string;
  password: string;
  ttl: number;
}

export interface RtcNetConfig {
  iceServers: RTCIceServer[];
  /** Give up establishing the connection after this long (ms). */
  connectionTimeoutMs: number;
  /** Cap for non-trickle ICE gathering (manual-signaling flows). */
  iceGatheringTimeoutMs: number;
  /** DataChannel bufferedAmount pause threshold (bytes). */
  backpressureBytes: number;
  /** How long a sender waits for a receiver `have` resume hint (ms). */
  resumeWaitMs: number;
  /** Diagnostics getStats poll interval (ms, 0 = off). */
  statsPollMs: number;
}

export const DEFAULT_STUN_URLS = ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"];

export const DEFAULT_CONNECTION_TIMEOUT_MS = 25_000;
export const DEFAULT_GATHERING_TIMEOUT_MS = 8_000;
export const DEFAULT_BACKPRESSURE_BYTES = 1 * 1024 * 1024;
export const DEFAULT_RESUME_WAIT_MS = 1_500;
export const DEFAULT_STATS_POLL_MS = 3_000;

function envNum(key: string, fallback: number): number {
  const raw = import.meta.env[key] as string | undefined;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envList(key: string, fallback: string[]): string[] {
  const raw = import.meta.env[key] as string | undefined;
  if (!raw || !raw.trim()) return fallback;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : fallback;
}

export function defaultRtcNetConfig(): RtcNetConfig {
  return {
    iceServers: envList("VITE_STUN_URLS", DEFAULT_STUN_URLS).map((urls) => ({ urls })),
    connectionTimeoutMs: envNum("VITE_RTC_CONNECTION_TIMEOUT_MS", DEFAULT_CONNECTION_TIMEOUT_MS),
    iceGatheringTimeoutMs: envNum("VITE_RTC_GATHERING_TIMEOUT_MS", DEFAULT_GATHERING_TIMEOUT_MS),
    backpressureBytes: envNum("VITE_RTC_BACKPRESSURE_BYTES", DEFAULT_BACKPRESSURE_BYTES),
    resumeWaitMs: envNum("VITE_RTC_RESUME_WAIT_MS", DEFAULT_RESUME_WAIT_MS),
    statsPollMs: envNum("VITE_RTC_STATS_POLL_MS", DEFAULT_STATS_POLL_MS),
  };
}

/** Append a TURN grant (in-memory, short-lived) ahead of STUN entries. */
export function withTurnServers(config: RtcNetConfig, grant: TurnGrant | null): RtcNetConfig {
  if (!grant || grant.urls.length === 0) return config;
  return {
    ...config,
    iceServers: [
      { urls: grant.urls, username: grant.username, credential: grant.password },
      ...config.iceServers,
    ],
  };
}

/** Derive the signaling HTTP base from its WS url (ws(s)://host[:port][/path]). */
export function wsToHttpBase(wsUrl: string): string {
  const http = wsUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
  return http.replace(/\/ws\/?$/, "").replace(/\/+$/, "");
}

/**
 * Fetch a short-lived TURN grant. Best-effort: resolves null when the
 * server has no TURN configured (503), is unreachable, or times out —
 * the caller then proceeds STUN-only and relies on automatic relay
 * fallback only if a grant arrives.
 */
export async function fetchTurnGrant(
  signalingHttpBase: string,
  timeoutMs = 5_000,
): Promise<TurnGrant | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${signalingHttpBase}/api/turn-creds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { [key: string]: unknown };
    if (body["ok"] !== true || !Array.isArray(body["urls"])) return null;
    return {
      urls: body["urls"] as string[],
      username: String(body["username"] ?? ""),
      password: String(body["password"] ?? ""),
      ttl: Number(body["ttl"] ?? 0),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type RouteKind = "direct" | "relay" | "unknown";

/**
 * Classify the selected ICE candidate pair without exposing addresses.
 * `relay` (remote or local) => TURN relay; host/srflx/prflx => direct.
 * Pure function — unit-tested with fake stats objects.
 */
export function classifyRoute(
  pair: {
    localType?: string;
    remoteType?: string;
  } | null,
): RouteKind {
  if (!pair) return "unknown";
  const types = [pair.localType ?? "", pair.remoteType ?? ""].map((s) => s.toLowerCase());
  if (types.some((t) => t === "relay")) return "relay";
  if (types.some((t) => t === "host" || t === "srflx" || t === "prflx")) return "direct";
  return "unknown";
}
