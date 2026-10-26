import { ArrowDownToLine, Download, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import type { ReceivedFile } from "@/hooks/use-transfer";

/**
 * ReceivedFiles — verified downloads for the receiver, with single and batch save actions.
 */
export function ReceivedFiles({ files }: { files: ReceivedFile[] }) {
  if (files.length === 0) return null;

  function saveAll() {
    for (const f of files) {
      const a = document.createElement("a");
      a.href = f.url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  }

  return (
    <div className="mt-3 space-y-2" aria-label="Received files">
      {files.length > 1 && (
        <div className="flex justify-end pb-1">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs font-semibold"
            onClick={saveAll}
          >
            <Download aria-hidden="true" className="size-3.5" /> Save all files
          </Button>
        </div>
      )}
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
          <Button size="sm" className="h-8 shrink-0 gap-1.5 text-xs font-semibold" asChild>
            <a href={f.url} download={f.name}>
              <ArrowDownToLine aria-hidden="true" className="size-3.5" /> Save
            </a>
          </Button>
        </div>
      ))}
    </div>
  );
}
