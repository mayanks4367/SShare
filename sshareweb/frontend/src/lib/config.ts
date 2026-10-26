/**
 * Runtime configuration. Deployment knobs (all build-time VITE_*):
 * VITE_SIGNALING_URL (wss://… in production), VITE_SSHARE_API_URL,
 * VITE_RECEIVER_BASE_URL, VITE_STUN_URLS. See DEPLOYMENT.md and .env.example.
 */
export function signalingUrl(): string {
  const fromEnv = import.meta.env["VITE_SIGNALING_URL"] as string | undefined;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  if (typeof window !== "undefined" && window.location?.hostname) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.hostname}:8787/ws`;
  }
  return "ws://localhost:8787/ws";
}

/** Page scheme without touching window on the server. */
export function pageIsSecure(): boolean {
  if (typeof window === "undefined" || !window.location) return false;
  return window.location.protocol === "https:";
}

function isInsecureScheme(url: string): boolean {
  return url.startsWith("ws://") || url.startsWith("http://");
}

/**
 * Detect endpoint misconfiguration BEFORE anything fails silently.
 * Browsers block ws:// WebSockets and http:// fetches from https:// pages
 * (mixed content), so an https deployment with localhost defaults needs
 * wss:// + https:// endpoints. Pure function — unit-tested.
 */
export function endpointWarnings(args: {
  pageSecure: boolean;
  signaling: string;
  gateway: string | null;
}): string[] {
  const out: string[] = [];
  if (!args.pageSecure) return out;
  if (isInsecureScheme(args.signaling)) {
    out.push(
      "This page is served over HTTPS but the signaling URL uses ws://, which browsers block. " +
        "Set VITE_SIGNALING_URL to a wss:// endpoint (see DEPLOYMENT.md).",
    );
  }
  if (args.gateway && isInsecureScheme(args.gateway)) {
    out.push(
      "This page is served over HTTPS but the gateway URL uses http://, which browsers block. " +
        "Serve the gateway over HTTPS or via the same TLS proxy.",
    );
  }
  return out;
}
