import { ArrowDownToLine, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import type { ReceivedFile } from "@/hooks/use-transfer";

/**
 * ReceivedFiles — verified downloads for the receiver, in FileRow styling.
 */
export function ReceivedFiles({ files }: { files: ReceivedFile[] }) {
  if (files.length === 0) return null;
  return (
    <div className="mt-3 space-y-2" aria-label="Received files">
      {files.map((f) => (
        <div
          key={f.id}
          className="flex min-w-0 items-center gap-3 rounded-xl border border-swarm/25 bg-swarm/[0.05] px-3 py-2.5"
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground">
            <FileText aria-hidden="true" className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{f.name}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {formatBytes(f.size)} · checksum verified
            </p>
          </div>
          <Button variant="secondary" size="sm" className="h-8 shrink-0 gap-1.5 text-xs" asChild>
            <a href={f.url} download={f.name}>
              <ArrowDownToLine aria-hidden="true" className="size-3.5" /> Save
            </a>
          </Button>
        </div>
      ))}
    </div>
  );
}
