import { formatBytes, formatEta, formatPercent, formatSpeed } from "@/lib/format";
import type { ActiveFileProgress } from "@/hooks/use-transfer";

/**
 * TransferProgress — live bar + Speed/ETA/Sent metrics in the page's
 * Metric visual language.
 */
export function TransferProgress({ progress }: { progress: ActiveFileProgress | null }) {
  if (!progress) {
    return (
      <div className="mt-4 grid grid-cols-3 gap-2 border-t border-border/70 pt-3">
        <Metric label="Speed" value="—" />
        <Metric label="ETA" value="—" />
        <Metric label="Sent" value="—" />
      </div>
    );
  }
  return (
    <div>
      <div
        className="mt-3 h-2 overflow-hidden rounded-full bg-background/60"
        role="progressbar"
        aria-valuenow={Math.round(progress.percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Transfer progress for ${progress.fileName}`}
      >
        <div
          className="h-full rounded-full bg-swarm transition-[width] duration-200"
          style={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }}
        />
      </div>
      <p className="mt-2 truncate text-xs text-muted-foreground" title={progress.fileName}>
        {progress.fileTotal > 1 ? `File ${progress.fileIndex + 1}/${progress.fileTotal} · ` : ""}
        {progress.fileName} · {formatPercent(progress.percent)} ·{" "}
        {formatBytes(progress.bytesTransferred)} / {formatBytes(progress.totalBytes)}
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border/70 pt-3">
        <Metric label="Speed" value={formatSpeed(progress.speedBps)} />
        <Metric label="ETA" value={formatEta(progress.etaSec)} />
        <Metric label="Sent" value={formatBytes(progress.bytesTransferred)} />
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}
