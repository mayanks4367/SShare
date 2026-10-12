/**
 * Share-link helpers for automatic session joining.
 *
 * The sender's QR encodes a full receiver URL (`<base>/r/<CODE>`); the
 * receiver route parses the code back out and joins without manual entry.
 * No file contents ever appear in links — only the room code.
 */

/** Mirrors the signaling server's ROOM_ID_RE (`signaling/src/protocol.ts`). */
export const ROOM_CODE_RE = /^[A-Z0-9-]{3,32}$/;

/** Normalize user- or URL-supplied input; null when not a valid room code. */
export function normalizeRoomCode(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const code = raw.trim().toUpperCase();
  return ROOM_CODE_RE.test(code) ? code : null;
}

/**
 * Base URL that receivers open. Priority: explicit per-device override
 * (localStorage, set once in the UI) → VITE_RECEIVER_BASE_URL → page origin.
 * Never hardcoded; "" during SSR (no window).
 */
export function receiverBaseUrl(): string {
  const custom = customLinkHost();
  if (custom) return custom;
  const fromEnv = (import.meta.env["VITE_RECEIVER_BASE_URL"] as string | undefined)?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  if (typeof window !== "undefined" && window.location?.origin) return window.location.origin;
  return "";
}

const LINK_HOST_KEY = "sshare.linkHost";

/**
 * Per-device share-link host override (e.g. http://192.168.1.5:5173).
 * A web page cannot discover the laptop's LAN address by itself, so the
 * user enters it once and the device remembers it. Returns null when unset.
 */
export function customLinkHost(): string | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const raw = window.localStorage.getItem(LINK_HOST_KEY)?.trim() ?? "";
    return raw ? raw.replace(/\/+$/, "") : null;
  } catch {
    return null; // storage blocked (private mode): behave as unset
  }
}

export function setCustomLinkHost(value: string | null): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    const v = (value ?? "").trim().replace(/\/+$/, "");
    if (v) window.localStorage.setItem(LINK_HOST_KEY, v);
    else window.localStorage.removeItem(LINK_HOST_KEY);
  } catch {
    /* storage blocked: ignore */
  }
}

/** True for loopback bases (localhost, 127/8, ::1) — unreachable from phones. */
export function isLoopbackBase(url: string): boolean {
  const host = urlToHost(url)
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host === "127.0.0.1" ||
    host.startsWith("127.")
  );
}

function urlToHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Full receiver link for a validated room code. */
export function receiverLink(code: string, base?: string): string {
  const root = (base ?? receiverBaseUrl()).replace(/\/+$/, "");
  return `${root}/r/${code}`;
}
