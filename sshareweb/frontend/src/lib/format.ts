/** Shared display formatting for transfer stats. */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unit;
  const decimals = unit === 0 ? 0 : value >= 100 ? 0 : 1;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: decimals })} ${units[unit]}`;
}

export function formatSpeed(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "—";
  return `${formatBytes(bps)}/s`;
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

export function formatPercent(p: number): string {
  if (!Number.isFinite(p)) return "—";
  return `${Math.min(100, Math.max(0, p)).toFixed(1)}%`;
}
