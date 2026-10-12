import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowDownToLine, ArrowRight, CircleAlert, CloudOff, Files, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TransferProgress } from "@/components/transfer/transfer-progress";
import { ReceivedFiles } from "@/components/transfer/received-files";
import { useTransfer } from "@/hooks/use-transfer";
import { normalizeRoomCode } from "@/lib/share-link";
import { formatBytes } from "@/lib/format";

export const Route = createFileRoute("/r/$code")({
  component: JoinRoute,
});

function JoinRoute() {
  const { code } = Route.useParams();
  return <JoinByLink rawCode={code} />;
}

/**
 * Automatic session joining: the code comes from the link path, is
 * validated, and after one explicit approval tap the existing
 * signaling + WebRTC flow starts — no manual code entry.
 */
export function JoinByLink({ rawCode }: { rawCode: string }) {
  const code = normalizeRoomCode(rawCode);
  const [approved, setApproved] = useState(false);
  const [declined, setDeclined] = useState(false);
  const transfer = useTransfer();
  const { phase, progress, received, failure, notice, peers } = transfer;
  const senderPresent = peers.some((p) => p.role === "sender");
  const busy =
    phase === "connecting" ||
    phase === "waiting-for-peer" ||
    phase === "peer-connected" ||
    phase === "transferring" ||
    phase === "paused";

  if (!code) {
    return (
      <JoinShell title="Invalid share link">
        <div role="status" className="transfer-enter text-center">
          <span className="mx-auto grid size-9 place-items-center rounded-xl border border-warm/20 bg-warm/10 text-warm">
            <CircleAlert aria-hidden="true" className="size-4" />
          </span>
          <p className="mt-3 text-sm font-semibold">This link won&apos;t work</p>
          <p className="mx-auto mt-1 max-w-xs text-xs leading-5 text-muted-foreground">
            The transfer code in the URL isn&apos;t valid. Ask the sender for a fresh link or enter
            the code manually.
          </p>
          <HomeButton />
        </div>
      </JoinShell>
    );
  }

  if (declined) {
    return (
      <JoinShell title="Transfer declined">
        <div className="transfer-enter text-center">
          <p className="text-sm font-semibold">No problem</p>
          <p className="mx-auto mt-1 max-w-xs text-xs leading-5 text-muted-foreground">
            You declined this transfer. Nothing was downloaded and the sender was not connected.
          </p>
          <HomeButton />
        </div>
      </JoinShell>
    );
  }

  if (!approved) {
    return (
      <JoinShell title="Incoming transfer">
        <div className="transfer-enter text-center">
          <span className="mx-auto grid size-14 place-items-center rounded-2xl border border-swarm/20 bg-swarm/10 text-swarm">
            <ArrowDownToLine aria-hidden="true" className="size-6" strokeWidth={1.7} />
          </span>
          <p className="mt-4 text-sm font-semibold">Someone wants to send you files</p>
          <p className="mt-2 font-mono text-xl font-bold tracking-[0.2em] text-foreground">
            {code}
          </p>
          <p className="mx-auto mt-2 max-w-xs text-xs leading-5 text-muted-foreground">
            File details appear once you approve — only join if you were expecting this transfer.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2.5">
            <Button
              className="h-11 rounded-xl px-4 font-semibold"
              onClick={() => {
                setApproved(true);
                void transfer.joinWithCode(code);
              }}
            >
              <ArrowRight aria-hidden="true" className="size-4" /> Approve &amp; join
            </Button>
            <Button
              variant="secondary"
              className="h-11 rounded-xl border border-border px-4"
              onClick={() => setDeclined(true)}
            >
              <X aria-hidden="true" className="size-4" /> Decline
            </Button>
          </div>
        </div>
      </JoinShell>
    );
  }

  if (phase === "failed") {
    return (
      <JoinShell title="Could not join">
        <div role="status" className="transfer-enter text-center">
          <span className="mx-auto grid size-9 place-items-center rounded-xl border border-warm/20 bg-warm/10 text-warm">
            <CloudOff aria-hidden="true" className="size-4" />
          </span>
          <p className="mt-3 text-sm font-semibold">Couldn&apos;t join this transfer</p>
          <p className="mx-auto mt-1 max-w-xs text-xs leading-5 text-muted-foreground">
            {failure || "The session may have expired, filled up, or gone offline."}
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2.5">
            <Button
              variant="secondary"
              className="h-10 rounded-xl border border-border px-4"
              onClick={() => transfer.retry()}
            >
              Try again
            </Button>
            <HomeButton />
          </div>
        </div>
      </JoinShell>
    );
  }

  if (phase === "completed") {
    return (
      <JoinShell title="Transfer complete">
        <div role="status" className="transfer-enter">
          <p className="text-sm font-semibold">
            {received.length} {received.length === 1 ? "file" : "files"} received · checksums
            verified
          </p>
          <ReceivedFiles files={received} />
          <HomeButton />
        </div>
      </JoinShell>
    );
  }

  return (
    <JoinShell title={`Joining ${code}`}>
      <div className="transfer-enter">
        <span className="grid size-9 place-items-center rounded-xl border border-swarm/20 bg-swarm/10 text-swarm">
          <Files aria-hidden="true" className="size-4" />
        </span>
        <p className="mt-3 font-mono text-lg font-bold tracking-[0.2em]">{code}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {progress
            ? `${progress.fileName} · ${formatBytes(progress.totalBytes)}`
            : phase === "transferring"
              ? "Receiving…"
              : senderPresent
                ? "Sender is here — establishing the direct connection…"
                : "Connecting to the sender…"}
        </p>
        {notice ? (
          <p role="status" className="mt-1 text-xs leading-5 text-muted-foreground">
            {notice}
          </p>
        ) : null}
        <TransferProgress progress={progress} />
        {busy && (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs"
              onClick={() => transfer.cancel()}
            >
              <X aria-hidden="true" /> Cancel
            </Button>
          </div>
        )}
      </div>
    </JoinShell>
  );
}

function JoinShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-md px-5 pb-9 pt-10 sm:pt-14">
        <p className="text-center text-[15px] font-semibold">Swarm Share</p>
        <section
          className="mt-6 rounded-[22px] border border-border/80 bg-card/80 p-5"
          aria-label={title}
        >
          {children}
        </section>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Files move directly between devices — nothing is uploaded.
        </p>
      </div>
    </main>
  );
}

function HomeButton() {
  return (
    <div className="mt-4">
      <a
        href="/"
        className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-secondary px-4 text-sm font-medium text-secondary-foreground"
      >
        Go home
      </a>
    </div>
  );
}
