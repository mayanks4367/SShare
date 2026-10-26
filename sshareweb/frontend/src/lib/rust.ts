/**
 * Rust gateway client (see WEB_INTEGRATION.md §3).
 *
 * Used for metadata/inventory/publishing and for the DELIBERATE per-chunk
 * HTTP fallback when no WebRTC channel exists. Bulk transfer stays P2P;
 * nothing here sends file bytes to signaling.
 */
import { sha256Hex } from "@/lib/transfer";

/** Browser-facing manifest served by GET /api/web-manifest/:file_id. */
export interface WebManifest {
  file_id: string;
  file_name: string;
  mime: string;
  file_size: number;
  chunk_size: number;
  total_chunks: number;
  chunk_hashes_blake3: string[];
  chunk_hashes_sha256: string[];
  sha256: string | null;
  compressed: boolean;
  created_at: number;
}

export interface GatewayHealth {
  ok: boolean;
  peer_id: string;
  version: string;
  files: number;
  total_bytes: number;
}

export function gatewayBase(): string {
  const fromEnv = import.meta.env["VITE_SSHARE_API_URL"] as string | undefined;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim().replace(/\/+$/, "");
  if (typeof window !== "undefined" && window.location?.hostname) {
    const proto = window.location.protocol === "https:" ? "https:" : "http:";
    return `${proto}//${window.location.hostname}:8080`;
  }
  return "http://localhost:8080";
}

export class GatewayError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function getJson(base: string, path: string, signal?: AbortSignal): Promise<unknown> {
  const init: RequestInit = {};
  if (signal) init.signal = signal;
  const res = await fetch(`${base}${path}`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GatewayError(res.status, text || `request failed (${res.status})`);
  }
  return res.json() as Promise<unknown>;
}

function asRecord(v: unknown): { [key: string]: unknown } {
  if (typeof v !== "object" || v === null)
    throw new GatewayError(500, "malformed gateway response");
  return v as { [key: string]: unknown };
}

export async function getHealth(base: string = gatewayBase()): Promise<GatewayHealth> {
  const v = asRecord(await getJson(base, "/api/health"));
  if (v["ok"] !== true) throw new GatewayError(500, "gateway reports unhealthy");
  return {
    ok: true,
    peer_id: String(v["peer_id"] ?? ""),
    version: String(v["version"] ?? ""),
    files: Number(v["files"] ?? 0),
    total_bytes: Number(v["total_bytes"] ?? 0),
  };
}

export async function getWebManifest(
  base: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<WebManifest> {
  const v = asRecord(
    await getJson(base, `/api/web-manifest/${encodeURIComponent(fileId)}`, signal),
  );
  const blake3 = v["chunk_hashes_blake3"];
  if (typeof v["file_id"] !== "string" || !Array.isArray(blake3)) {
    throw new GatewayError(500, "malformed web manifest");
  }
  const shaList = v["chunk_hashes_sha256"];
  return {
    file_id: v["file_id"] as string,
    file_name: String(v["file_name"] ?? "download"),
    mime: String(v["mime"] ?? "") || "application/octet-stream",
    file_size: Number(v["file_size"] ?? 0),
    chunk_size: Number(v["chunk_size"] ?? 0),
    total_chunks: Number(v["total_chunks"] ?? 0),
    chunk_hashes_blake3: blake3 as string[],
    chunk_hashes_sha256: Array.isArray(shaList) ? (shaList as string[]) : [],
    sha256: typeof v["sha256"] === "string" ? (v["sha256"] as string) : null,
    compressed: v["compressed"] === true,
    created_at: Number(v["created_at"] ?? 0),
  };
}

/**
 * Deliberate fallback download: fetch stored chunks one by one over HTTP,
 * verifying per-chunk SHA-256 (when the manifest carries it) and the
 * whole-file SHA-256 at the end. Throws `GatewayError`/checksum `Error`.
 */
export async function downloadViaGateway(
  base: string,
  manifest: WebManifest,
  opts: {
    onProgress?: (bytesTransferred: number, totalBytes: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<Uint8Array> {
  if (manifest.total_chunks !== manifest.chunk_hashes_blake3.length) {
    throw new Error("manifest inconsistent: chunk count mismatch");
  }
  const out = new Uint8Array(manifest.file_size);
  let off = 0;
  for (let i = 0; i < manifest.total_chunks; i++) {
    const init: RequestInit = {};
    if (opts.signal) init.signal = opts.signal;
    const res = await fetch(
      `${base}/api/chunks/${encodeURIComponent(manifest.file_id)}/${i}`,
      init,
    );
    if (!res.ok) throw new GatewayError(res.status, `chunk ${i} unavailable (${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const wantSha = manifest.chunk_hashes_sha256[i];
    if (typeof wantSha === "string" && wantSha.length > 0) {
      const got = await sha256Hex(bytes);
      if (got !== wantSha) throw new Error(`chunk ${i} failed SHA-256 check`);
    }
    out.set(bytes, off);
    off += bytes.length;
    opts.onProgress?.(off, manifest.file_size);
  }
  if (off !== manifest.file_size) {
    throw new Error(`reassembled size ${off} != expected ${manifest.file_size}`);
  }
  if (manifest.sha256) {
    const sum = await sha256Hex(out);
    if (sum !== manifest.sha256) throw new Error("whole-file checksum mismatch (file corrupted)");
  }
  return out;
}
