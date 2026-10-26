import {
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  CircleAlert,
  CloudOff,
  FileArchive,
  FileImage,
  FileText,
  FileVideo,
  Files,
  FolderOpen,
  Link2,
  LoaderCircle,
  Network,
  Pause,
  Play,
  QrCode,
  RotateCcw,
  ShieldCheck,
  X,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ShareCodeCard } from "@/components/transfer/share-code-card";
import { TransferProgress } from "@/components/transfer/transfer-progress";
import { ReceivedFiles } from "@/components/transfer/received-files";
import { useTransfer, type TransferPhase } from "@/hooks/use-transfer";
import { formatBytes } from "@/lib/format";
import { endpointWarnings, pageIsSecure, signalingUrl } from "@/lib/config";
import { gatewayBase } from "@/lib/rust";

type FileItem = { id: string; file: File };

const transferStateLabels: Record<TransferPhase, string> = {
  idle: "Ready when you are",
  "file-selected": "Files selected",
  "creating-session": "Creating session",
  "waiting-for-peer": "Waiting for peer",
  "peer-connected": "Peer connected",
  connecting: "Connecting",
  transferring: "Transferring",
  paused: "Paused",
  failed: "Unavailable",
  completed: "Completed",
};

const ACTIVE_PHASES: ReadonlySet<TransferPhase> = new Set([
  "creating-session",
  "waiting-for-peer",
  "peer-connected",
  "connecting",
  "transferring",
  "paused",
]);

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Swarm Share — direct file sharing" },
      {
        name: "description",
        content: "A simple workspace for sharing files directly between devices with Swarm Share.",
      },
      { property: "og:title", content: "Swarm Share — direct file sharing" },
      {
        property: "og:description",
        content: "Choose files and prepare a direct device-to-device handoff with Swarm Share.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: SwarmSharePage,
});

export function SwarmSharePage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<FileItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [shareCode, setShareCode] = useState("");
  const [joinError, setJoinError] = useState("");
  const [gatewayUrl, setGatewayUrl] = useState(gatewayBase());
  const [gatewayFileId, setGatewayFileId] = useState("");
  const totalBytes = items.reduce((sum, item) => sum + item.file.size, 0);
  const hasFiles = items.length > 0;

  const transfer = useTransfer();
  const {
    phase: state,
    failure,
    notice,
    sessionCode,
    progress,
    received,
    paused,
    link,
    route,
    role,
    source,
  } = transfer;
  const busy = ACTIVE_PHASES.has(state);

  function addFiles(fileList: FileList | File[]) {
    if (busy) return;
    const incoming = Array.from(fileList).map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`,
      file,
    }));
    if (incoming.length === 0) return;
    setItems((current) => {
      const next = [...current, ...incoming];
      transfer.selectionChanged(next.length > 0);
      return next;
    });
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) addFiles(event.target.files);
    event.target.value = "";
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files);
  }

  function onDropzoneKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInputRef.current?.click();
    }
  }

  function createTransfer() {
    if (!hasFiles || busy) return;
    void transfer.startSend(items.map((item) => item.file));
  }

  function joinTransfer() {
    if (!shareCode.trim()) {
      setJoinError("Enter a share code to continue.");
      return;
    }
    setJoinError("");
    setJoinOpen(false);
    void transfer.joinWithCode(shareCode);
  }

  function downloadFromGateway() {
    if (!gatewayFileId.trim() || busy) return;
    setJoinError("");
    setJoinOpen(false);
    void transfer.fetchFromGateway(gatewayFileId, gatewayUrl);
  }

  function clearSelection() {
    transfer.reset();
    setItems([]);
  }

  function removeItem(id: string) {
    if (busy) return;
    setItems((current) => {
      const next = current.filter((item) => item.id !== id);
      transfer.selectionChanged(next.length > 0);
      return next;
    });
  }

  return (
    <main className="min-h-screen overflow-hidden bg-background text-foreground">
      <div className="mx-auto w-full max-w-6xl px-5 pb-9 pt-6 sm:px-8 sm:pt-9">
        <header className="flex items-center justify-between gap-4">
          <a
            href="/"
            className="flex items-center gap-3 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Swarm Share home"
          >
            <span className="grid size-10 place-items-center rounded-xl border border-swarm/25 bg-swarm/10 text-swarm">
              <Network aria-hidden="true" className="size-5" strokeWidth={1.8} />
            </span>
            <span className="text-[15px] font-semibold">Swarm Share</span>
          </a>
          <ServicePill link={link} />
        </header>

        <ConfigBanner />

        <section className="mt-9 sm:mt-12" aria-labelledby="page-title">
          <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-swarm">
            <Zap aria-hidden="true" className="size-3.5" /> Direct device-to-device sharing
          </p>
          <div className="mt-3 flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
            <div className="max-w-2xl">
              <h1
                id="page-title"
                className="font-display text-4xl font-semibold leading-[1.05] sm:text-5xl"
              >
                Pass files straight across.
              </h1>
              <p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
                Pick a file, choose a direction, and prepare a simple handoff between your devices.
              </p>
            </div>
            <div className="flex flex-wrap gap-2.5">
              <Button
                className="h-11 rounded-xl px-4 font-semibold"
                disabled={!hasFiles || busy}
                onClick={createTransfer}
              >
                <span className="grid size-6 place-items-center rounded-lg bg-primary-foreground/15">
                  <ArrowRight aria-hidden="true" className="size-4" />
                </span>{" "}
                Create Transfer
              </Button>
              <Button
                variant="secondary"
                className="h-11 rounded-xl border border-border px-4"
                disabled={busy}
                onClick={() => {
                  setJoinError("");
                  setJoinOpen(true);
                }}
              >
                <Link2 aria-hidden="true" className="size-4" /> Join with code
              </Button>
            </div>
          </div>
        </section>

        <section
          className="mt-8 grid grid-cols-1 gap-3 sm:mt-10 sm:grid-cols-6"
          aria-label="Transfer workspace"
        >
          <section
            className="flex flex-col rounded-[22px] border border-border/80 bg-card/80 p-3 sm:col-span-4 sm:row-span-2"
            aria-label="File selection"
          >
            <div
              role="button"
              tabIndex={0}
              aria-label="Choose files to share"
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={onDropzoneKeyDown}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                  setIsDragging(false);
              }}
              onDrop={onDrop}
              className={`group flex min-h-[18rem] flex-1 cursor-pointer flex-col items-center justify-center rounded-[17px] border border-dashed px-5 py-8 text-center outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring sm:min-h-[21rem] ${isDragging ? "border-swarm bg-swarm/10" : "border-border bg-background/35 hover:border-swarm/50 hover:bg-swarm/[0.035]"}`}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="sr-only"
                onChange={onFileChange}
                aria-label="Choose files"
                disabled={busy}
              />
              {hasFiles ? (
                <>
                  <span className="grid size-14 place-items-center rounded-2xl border border-swarm/20 bg-swarm/10 text-swarm transition-transform duration-200 group-hover:-translate-y-0.5">
                    <Files aria-hidden="true" className="size-6" strokeWidth={1.7} />
                  </span>
                  <p className="mt-4 text-sm font-semibold">
                    {items.length} {items.length === 1 ? "file" : "files"} selected
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {formatBytes(totalBytes)} ready on this device
                  </p>
                  <span className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-swarm">
                    <FolderOpen aria-hidden="true" className="size-4" /> Add more files
                  </span>
                </>
              ) : (
                <>
                  <span className="grid size-14 place-items-center rounded-2xl border border-swarm/20 bg-swarm/10 text-swarm transition-transform duration-200 group-hover:-translate-y-0.5">
                    <ArrowDownToLine aria-hidden="true" className="size-6" strokeWidth={1.7} />
                  </span>
                  <p className="mt-4 text-sm font-semibold">Drop files to send</p>
                  <p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">
                    or click to browse. Nothing leaves this device until a transfer is ready.
                  </p>
                  <span className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-secondary px-3.5 text-sm font-medium text-secondary-foreground">
                    <FolderOpen aria-hidden="true" className="size-4" /> Choose files
                  </span>
                </>
              )}
            </div>
            {hasFiles && (
              <div className="mt-3 space-y-2" aria-label="Selected files">
                {items.map(({ id, file }) => (
                  <FileRow key={id} file={file} onRemove={() => removeItem(id)} />
                ))}
                <div className="flex items-center justify-between px-1 pt-0.5 text-xs text-muted-foreground">
                  <span>Total size</span>
                  <span className="font-medium text-foreground">{formatBytes(totalBytes)}</span>
                </div>
              </div>
            )}
            <ReceivedFiles files={received} />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-border/70 bg-background/45 px-3.5 py-3">
              <span className="text-sm font-medium text-muted-foreground">Connection</span>
              <ConnectionLine link={link} route={route} />
            </div>
          </section>

          <section
            className="flex min-h-[15rem] flex-col rounded-[22px] border border-border/80 bg-card/80 p-5 sm:col-span-2"
            aria-labelledby="transfer-status-heading"
          >
            <SectionLabel id="transfer-status-heading">Transfer status</SectionLabel>
            <div className="mt-3 flex flex-1 flex-col justify-center rounded-[14px] border border-border/60 bg-background/35 px-4 py-5">
              {state === "failed" ? (
                <div role="status" className="transfer-enter">
                  <span className="grid size-9 place-items-center rounded-xl border border-warm/20 bg-warm/10 text-warm">
                    <CircleAlert aria-hidden="true" className="size-4" />
                  </span>
                  <p className="mt-3 text-sm font-semibold">Transfer not started</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{failure}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2 text-xs"
                      onClick={() => transfer.retry()}
                    >
                      <RotateCcw aria-hidden="true" /> Try again
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2 text-xs"
                      onClick={clearSelection}
                    >
                      <X aria-hidden="true" /> Clear selection
                    </Button>
                  </div>
                </div>
              ) : state === "completed" ? (
                <div role="status" className="transfer-enter">
                  <span className="grid size-9 place-items-center rounded-xl border border-swarm/20 bg-swarm/10 text-swarm">
                    <Check aria-hidden="true" className="size-4" />
                  </span>
                  <p className="mt-3 text-sm font-semibold">Completed</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {role === "receiver"
                      ? `${received.length} ${received.length === 1 ? "file" : "files"} received · checksums verified`
                      : `${items.length} ${items.length === 1 ? "file" : "files"} sent · peer verified checksums`}
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2 h-8 px-2 text-xs"
                    onClick={clearSelection}
                  >
                    <X aria-hidden="true" /> Start over
                  </Button>
                </div>
              ) : busy ? (
                <div className="transfer-enter">
                  <span className="grid size-9 place-items-center rounded-xl border border-swarm/20 bg-swarm/10 text-swarm">
                    <Files aria-hidden="true" className="size-4" />
                  </span>
                  <p className="mt-3 text-sm font-semibold">{transferStateLabels[state]}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {role === "receiver"
                      ? source === "gateway"
                        ? "Downloading from gateway (fallback)"
                        : "Receiving from peer"
                      : `${items.length} ${items.length === 1 ? "file" : "files"} · ${formatBytes(totalBytes)}`}
                  </p>
                  {notice ? (
                    <p role="status" className="mt-1 text-xs leading-5 text-muted-foreground">
                      {notice}
                    </p>
                  ) : null}
                  <TransferProgress progress={progress} role={role} />
                  <div className="mt-3 flex flex-wrap gap-2">
                    {state === "transferring" && !paused && source !== "gateway" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 text-xs"
                        onClick={() => transfer.pause()}
                      >
                        <Pause aria-hidden="true" className="size-3.5" /> Pause
                      </Button>
                    )}
                    {state === "paused" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 text-xs"
                        onClick={() => transfer.resume()}
                      >
                        <Play aria-hidden="true" className="size-3.5" /> Resume
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2 text-xs"
                      onClick={() => transfer.cancel()}
                    >
                      <X aria-hidden="true" /> Cancel
                    </Button>
                  </div>
                </div>
              ) : hasFiles ? (
                <div className="transfer-enter">
                  <span className="grid size-9 place-items-center rounded-xl border border-swarm/20 bg-swarm/10 text-swarm">
                    <Files aria-hidden="true" className="size-4" />
                  </span>
                  <p className="mt-3 text-sm font-semibold">{transferStateLabels[state]}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {items.length} {items.length === 1 ? "file" : "files"} ·{" "}
                    {formatBytes(totalBytes)}
                  </p>
                  <p className="mt-3 text-xs leading-5 text-muted-foreground">
                    Progress, speed, and ETA appear once a peer connection is available.
                  </p>
                </div>
              ) : (
                <div className="text-center">
                  <span className="mx-auto grid size-9 place-items-center rounded-xl border border-border bg-secondary text-muted-foreground">
                    <LoaderCircle aria-hidden="true" className="size-4" />
                  </span>
                  <p className="mt-3 text-sm font-semibold">No files yet</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Select files to prepare a transfer.
                  </p>
                </div>
              )}
            </div>
            {!busy && state !== "completed" && <TransferProgress progress={null} role={role} />}
          </section>

          <section
            className="flex min-h-[14rem] flex-col rounded-[22px] border border-border/80 bg-card/80 p-5 sm:col-span-2"
            aria-labelledby="session-heading"
          >
            <div className="flex items-center justify-between gap-3">
              <SectionLabel id="session-heading">Session</SectionLabel>
              {sessionCode ? (
                <span className="rounded-full border border-swarm/30 bg-swarm/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-swarm">
                  Active
                </span>
              ) : (
                <span className="rounded-full border border-border bg-secondary/70 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Not active
                </span>
              )}
            </div>
            {sessionCode ? (
              <ShareCodeCard code={sessionCode} />
            ) : (
              <>
                <div className="mt-3 flex flex-1 flex-col items-center justify-center rounded-[14px] border border-border/60 bg-background/35 px-4 py-4 text-center">
                  <ShieldCheck aria-hidden="true" className="size-5 text-swarm/80" />
                  <p className="mt-2 text-sm font-semibold">No active session</p>
                  <p className="mt-1 max-w-[15rem] text-xs leading-5 text-muted-foreground">
                    A share code will appear here when live transfers are available.
                  </p>
                </div>
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/50 bg-background/30 px-3 py-2.5 text-xs text-muted-foreground">
                  <Link2 aria-hidden="true" className="size-3.5 shrink-0" />
                  <span>Share code unavailable</span>
                </div>
              </>
            )}
          </section>

          <InfoTile icon={<QrCode aria-hidden="true" className="size-5" />} title="QR handoff">
            {sessionCode
              ? `Session ${sessionCode} is live — scan the code in the Session card on the receiving device.`
              : "A scannable code appears when a real session can be created."}
          </InfoTile>
          <InfoTile icon={<Check aria-hidden="true" className="size-5" />} title="Completion">
            {state === "completed"
              ? `${role === "receiver" ? received.length : items.length} files · every checksum verified`
              : "File details and a finished status show after a real transfer completes."}
          </InfoTile>
        </section>

        <footer className="mt-7 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4 text-xs text-muted-foreground">
          <p>Swarm Share · direct device-to-device handoff</p>
          <FooterStatus link={link} />
        </footer>
      </div>

      <Dialog open={joinOpen} onOpenChange={setJoinOpen}>
        <DialogContent className="border-border bg-card text-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Join a transfer</DialogTitle>
            <DialogDescription>
              Enter the share code from the person sending you files.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              joinTransfer();
            }}
            className="space-y-3"
          >
            <label htmlFor="share-code" className="text-sm font-medium">
              Share code
            </label>
            <Input
              id="share-code"
              autoComplete="off"
              value={shareCode}
              onChange={(event) => {
                setShareCode(event.target.value);
                setJoinError("");
              }}
              placeholder="e.g. SS-ABC123"
              className="h-11 border-border bg-background font-mono uppercase"
            />
            {joinError && (
              <p role="alert" className="text-sm text-warm">
                {joinError}
              </p>
            )}
            <Button type="submit" className="h-10 w-full rounded-lg">
              <ArrowRight aria-hidden="true" /> Join transfer
            </Button>
          </form>
          <div className="mt-5 border-t border-border/70 pt-4">
            <p className="text-sm font-medium">No live peer?</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Fall back to a Rust gateway: chunks download over HTTP with the same checksum
              verification.
            </p>
            <div className="mt-3 space-y-3">
              <div>
                <label htmlFor="gateway-url" className="text-sm font-medium">
                  Gateway
                </label>
                <Input
                  id="gateway-url"
                  autoComplete="off"
                  value={gatewayUrl}
                  onChange={(event) => setGatewayUrl(event.target.value)}
                  placeholder="http://localhost:8080"
                  className="mt-1 h-10 border-border bg-background font-mono text-xs"
                />
              </div>
              <div>
                <label htmlFor="gateway-file-id" className="text-sm font-medium">
                  File ID
                </label>
                <Input
                  id="gateway-file-id"
                  autoComplete="off"
                  value={gatewayFileId}
                  onChange={(event) => setGatewayFileId(event.target.value)}
                  placeholder="64-char BLAKE3 file id"
                  className="mt-1 h-10 border-border bg-background font-mono text-xs"
                />
              </div>
              <Button
                type="button"
                variant="secondary"
                className="h-10 w-full rounded-lg border border-border"
                disabled={!gatewayFileId.trim() || busy}
                onClick={downloadFromGateway}
              >
                <ArrowDownToLine aria-hidden="true" /> Download via gateway
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function ConfigBanner() {
  const warnings = endpointWarnings({
    pageSecure: pageIsSecure(),
    signaling: signalingUrl(),
    gateway: gatewayBase(),
  });
  if (warnings.length === 0) return null;
  return (
    <div
      role="alert"
      className="mt-5 rounded-[14px] border border-warm/25 bg-warm/[0.07] px-4 py-3 text-xs leading-5 text-muted-foreground"
    >
      {warnings.map((w) => (
        <p key={w.slice(0, 48)} className="mt-1 first:mt-0">
          {w}
        </p>
      ))}
    </div>
  );
}

function ServicePill({ link }: { link: "offline" | "link" | "live" | "failed" }) {
  if (link === "live") {
    return (
      <div className="flex max-w-[13rem] items-center gap-2 rounded-full border border-border bg-secondary/70 px-3 py-2 text-xs font-medium text-muted-foreground sm:max-w-none">
        <span className="relative grid size-2 shrink-0 place-items-center">
          <span className="absolute size-2 animate-ping rounded-full bg-swarm/60" />
          <span className="relative size-1.5 rounded-full bg-swarm" />
        </span>
        <span>Live · peer connected</span>
      </div>
    );
  }
  const text =
    link === "link"
      ? "Connecting to peer…"
      : link === "failed"
        ? "Connection failed"
        : "Transfer service unavailable";
  return (
    <div className="flex max-w-[13rem] items-center gap-2 rounded-full border border-border bg-secondary/70 px-3 py-2 text-xs font-medium text-muted-foreground sm:max-w-none">
      <span className="relative grid size-2 shrink-0 place-items-center">
        <span className="absolute size-2 animate-ping rounded-full bg-warm/60" />
        <span className="relative size-1.5 rounded-full bg-warm" />
      </span>
      <span>{text}</span>
    </div>
  );
}

function ConnectionLine({
  link,
  route,
}: {
  link: "offline" | "link" | "live" | "failed";
  route: "direct" | "relay" | "unknown";
}) {
  if (link === "live") {
    if (route === "relay") {
      return (
        <span className="inline-flex items-center gap-2 text-xs font-medium text-sky">
          <Network aria-hidden="true" className="size-3.5" /> Peer connected · relayed via TURN
          (encrypted)
        </span>
      );
    }
    if (route === "direct") {
      return (
        <span className="inline-flex items-center gap-2 text-xs font-medium text-swarm">
          <Network aria-hidden="true" className="size-3.5" /> Peer connected · direct P2P
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-2 text-xs font-medium text-swarm">
        <Network aria-hidden="true" className="size-3.5" /> Peer connected · establishing route…
      </span>
    );
  }
  if (link === "link") {
    return (
      <span className="inline-flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> Signaling connected —
        waiting for peer…
      </span>
    );
  }
  if (link === "failed") {
    return (
      <span className="inline-flex items-center gap-2 text-xs font-medium text-warm">
        <CloudOff aria-hidden="true" className="size-3.5" /> Connection failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 text-xs font-medium text-warm">
      <CloudOff aria-hidden="true" className="size-3.5" /> No transfer service connected
    </span>
  );
}

function FooterStatus({ link }: { link: "offline" | "link" | "live" | "failed" }) {
  if (link === "live") {
    return (
      <p className="flex items-center gap-2">
        <Network aria-hidden="true" className="size-3.5" /> Live peer connection
      </p>
    );
  }
  return (
    <p className="flex items-center gap-2">
      <CloudOff aria-hidden="true" className="size-3.5" />{" "}
      {link === "link"
        ? "Connecting…"
        : link === "failed"
          ? "Connection failed"
          : "Transfer service unavailable"}
    </p>
  );
}

function FileRow({ file, onRemove }: { file: File; onRemove: () => void }) {
  const Icon = fileIcon(file.type);
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border/60 bg-background/40 px-3 py-2.5">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground">
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{file.name}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {formatBytes(file.size)} · {file.type || "File"}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 text-muted-foreground"
        onClick={onRemove}
        aria-label={`Remove ${file.name}`}
        title="Remove file"
      >
        <X aria-hidden="true" className="size-4" />
      </Button>
    </div>
  );
}

function SectionLabel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2
      id={id}
      className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground"
    >
      {children}
    </h2>
  );
}

function InfoTile({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      className="flex min-h-[6.5rem] items-center gap-4 rounded-[22px] border border-border/80 bg-card/80 p-5 sm:col-span-3"
      aria-label={title}
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-swarm/20 bg-swarm/10 text-swarm">
        {icon}
      </span>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{children}</p>
      </div>
    </section>
  );
}

function fileIcon(type: string) {
  if (type.startsWith("image/")) return FileImage;
  if (type.startsWith("video/")) return FileVideo;
  if (type.includes("zip") || type.includes("archive") || type.includes("compressed"))
    return FileArchive;
  return FileText;
}
