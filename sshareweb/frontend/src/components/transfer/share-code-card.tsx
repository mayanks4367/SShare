import { useState } from "react";
import { Check, Copy, Link2, TriangleAlert } from "lucide-react";
import QRCode from "react-qr-code";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { customLinkHost, isLoopbackBase, receiverLink, setCustomLinkHost } from "@/lib/share-link";

/**
 * ShareCodeCard — live session code + shareable receiver link + QR handoff.
 * The QR encodes the full receiver URL so the phone joins automatically;
 * the manual code remains as a fallback. Same card language as the page.
 */
export function ShareCodeCard({ code }: { code: string | null }) {
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  // Per-device link host (e.g. the laptop's LAN address). A browser cannot
  // discover it alone, so the user enters it once and it is remembered.
  const [host, setHost] = useState<string | null>(() => customLinkHost());
  const [hostDraft, setHostDraft] = useState("");
  const [editingHost, setEditingHost] = useState(false);

  async function copy(text: string, which: "code" | "link") {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API unavailable (permissions/iframe): select manually.
      return;
    }
    setCopied(which);
    setTimeout(() => setCopied(null), 1600);
  }

  if (!code) {
    return (
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/50 bg-background/30 px-3 py-2.5 text-xs text-muted-foreground">
        <Link2 aria-hidden="true" className="size-3.5 shrink-0" />
        <span>Share code unavailable</span>
      </div>
    );
  }

  const link = receiverLink(code, host ?? undefined);
  const loopback = isLoopbackBase(link);

  function saveHost() {
    const v = hostDraft.trim().replace(/\/+$/, "");
    setCustomLinkHost(v || null);
    setHost(v || null);
    setHostDraft("");
    setEditingHost(false);
  }

  return (
    <div className="mt-3 rounded-[14px] border border-swarm/25 bg-swarm/[0.06] px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Share code
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() => void copy(code, "code")}
          aria-label="Copy share code"
        >
          {copied === "code" ? (
            <Check aria-hidden="true" className="size-3.5" />
          ) : (
            <Copy aria-hidden="true" className="size-3.5" />
          )}
          {copied === "code" ? "Copied" : "Copy"}
        </Button>
      </div>
      <p
        className="mt-1 font-mono text-2xl font-bold tracking-[0.2em] text-foreground"
        aria-live="polite"
      >
        {code}
      </p>
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/50 bg-background/30 px-3 py-2">
        <Link2 aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {link}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1.5 px-2 text-xs"
          onClick={() => void copy(link, "link")}
          aria-label="Copy share link"
        >
          {copied === "link" ? (
            <Check aria-hidden="true" className="size-3.5" />
          ) : (
            <Copy aria-hidden="true" className="size-3.5" />
          )}
          {copied === "link" ? "Copied" : "Copy link"}
        </Button>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <span className="grid shrink-0 place-items-center rounded-xl bg-white p-2">
          <QRCode
            value={link}
            size={84}
            bgColor="#ffffff"
            fgColor="#0b1220"
            aria-label={`QR code for ${code}`}
          />
        </span>
        <p className="text-xs leading-5 text-muted-foreground">
          Scan to open this transfer on the receiving device — no code typing needed. Files move
          peer-to-peer — nothing is uploaded.
        </p>
      </div>
      {loopback ? (
        <div
          role="note"
          className="mt-3 flex items-start gap-2 rounded-lg border border-warm/25 bg-warm/[0.07] px-3 py-2.5 text-xs leading-5 text-muted-foreground"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warm" />
          <span>
            This link only works on this device. For phones on the same Wi-Fi, enter this
            device&apos;s LAN address once — it stays saved here.
          </span>
        </div>
      ) : null}
      {editingHost || host ? (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            saveHost();
          }}
        >
          <Input
            value={editingHost ? hostDraft : (host ?? "")}
            onChange={(event) => {
              if (!editingHost) setEditingHost(true);
              setHostDraft(event.target.value);
            }}
            onFocus={() => {
              setEditingHost(true);
              setHostDraft(host ?? "");
            }}
            placeholder="http://192.168.1.5:5173"
            aria-label="Link host for QR codes"
            className="h-9 border-border bg-background font-mono text-xs"
          />
          <Button type="submit" variant="secondary" size="sm" className="h-9 shrink-0 text-xs">
            Save
          </Button>
          {host ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-9 shrink-0 text-xs"
              onClick={() => {
                setCustomLinkHost(null);
                setHost(null);
                setHostDraft("");
                setEditingHost(false);
              }}
            >
              Clear
            </Button>
          ) : null}
        </form>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="mt-3 h-8 px-2 text-xs"
          onClick={() => setEditingHost(true)}
        >
          Use a LAN address for phones
        </Button>
      )}
    </div>
  );
}
