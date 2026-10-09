/**
 * Minimal UI wiring. All transfer logic lives in `transfer-engine/`;
 * this file only binds DOM <-> engine + manual signaling.
 */
import {
  TransferPeer,
  buildMetadata,
  clampChunkSize,
  generateSessionId,
  sha256Hex,
  toDownloadUrl,
  type TransferMetadata,
} from "../transfer-engine/index.js";
import {
  acceptAnswerCode,
  acceptOfferAndMakeAnswer,
  createOfferCode,
} from "../signaling/manual.js";

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};
const input = (id: string): HTMLInputElement => $(id) as HTMLInputElement;
const area = (id: string): HTMLTextAreaElement => $(id) as HTMLTextAreaElement;
const btn = (id: string): HTMLButtonElement => $(id) as HTMLButtonElement;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 ** 2).toFixed(2)} MiB`;
}
function fmtSpeed(bps: number): string {
  if (!isFinite(bps) || bps <= 0) return "—";
  return `${fmtBytes(bps)}/s`;
}
function fmtEta(s: number): string {
  if (!isFinite(s)) return "—";
  return `${s.toFixed(0)}s`;
}

// ---------- sender ----------
let sender: TransferPeer | null = null;
let senderFile: File | null = null;
let senderMeta: TransferMetadata | null = null;
let sessionId = "";

btn("btn-create").addEventListener("click", async () => {
  try {
    sender?.close();
    sessionId = generateSessionId();
    $("session-id").textContent = sessionId;
    sender = new TransferPeer("sender", {
      onConnection: (s) => {
        $("sender-conn").textContent = s;
      },
      onTransfer: (s) => {
        $("sender-xfer").textContent = s;
        btn("btn-send").disabled = !(s === "idle" && senderMeta);
      },
      onProgress: (p) => {
        ($("sender-bar") as HTMLElement).style.width = `${p.percent.toFixed(1)}%`;
        $("sender-stats").textContent =
          `${fmtBytes(p.bytesTransferred)} / ${fmtBytes(p.totalBytes)} (${p.percent.toFixed(1)}%) · ${fmtSpeed(p.speedBps)} · ETA ${fmtEta(p.etaSec)}`;
      },
      onError: (e) => {
        $("sender-err").textContent = e.message;
      },
      onCancelled: () => {
        $("sender-err").textContent = "transfer cancelled";
      },
    });
    area("offer-out").value = "gathering ICE…";
    area("offer-out").value = await createOfferCode(sender.pc);
  } catch (e) {
    $("sender-err").textContent = e instanceof Error ? e.message : String(e);
  }
});

input("file-input").addEventListener("change", async () => {
  const f = input("file-input").files?.[0] ?? null;
  senderFile = f;
  senderMeta = null;
  if (!f) {
    $("file-meta").textContent = "no file selected";
    return;
  }
  const chunkKB = Number(input("chunk-kb").value || 64);
  const chunkSize = clampChunkSize(chunkKB * 1024);
  $("file-meta").textContent = "hashing (SHA-256)…";
  const bytes = new Uint8Array(await f.arrayBuffer());
  const checksum = await sha256Hex(bytes);
  const id = sessionId || generateSessionId();
  if (!sessionId) {
    sessionId = id;
    $("session-id").textContent = sessionId;
  }
  senderMeta = buildMetadata({
    transferId: id,
    fileName: f.name,
    fileSize: f.size,
    mimeType: f.type,
    chunkSize,
    checksum,
  });
  $("file-meta").textContent =
    `${f.name} · ${fmtBytes(f.size)} · chunk ${fmtBytes(chunkSize)} · ${senderMeta.totalChunks} chunks · sha256 ${checksum.slice(0, 16)}…`;
  btn("btn-send").disabled = !(sender?.channelOpen() && senderMeta);
});

btn("btn-accept-answer").addEventListener("click", async () => {
  try {
    if (!sender) throw new Error("create a session first");
    await acceptAnswerCode(sender.pc, area("answer-in").value);
    $("sender-err").textContent = "connected — waiting for channel…";
    // Enable send once channel opens (poll, simple + robust).
    const t = setInterval(() => {
      if (sender?.channelOpen()) {
        clearInterval(t);
        $("sender-err").textContent = "";
        btn("btn-send").disabled = !senderMeta;
        btn("btn-cancel-send").disabled = false;
      }
    }, 300);
  } catch (e) {
    $("sender-err").textContent = e instanceof Error ? e.message : String(e);
  }
});

btn("btn-send").addEventListener("click", async () => {
  try {
    if (!sender || !senderFile || !senderMeta) throw new Error("need session + file + connection");
    btn("btn-send").disabled = true;
    await sender.sendFile(senderMeta, senderFile);
  } catch (e) {
    $("sender-err").textContent = e instanceof Error ? e.message : String(e);
    btn("btn-send").disabled = false;
  }
});

btn("btn-cancel-send").addEventListener("click", () => sender?.cancel("sender cancelled"));
btn("btn-copy-offer").addEventListener("click", () => void navigator.clipboard.writeText(area("offer-out").value));

// ---------- receiver ----------
let receiver: TransferPeer | null = null;

btn("btn-join").addEventListener("click", async () => {
  try {
    receiver?.close();
    ($("download-link") as HTMLAnchorElement).style.display = "none";
    receiver = new TransferPeer("receiver", {
      onConnection: (s) => {
        $("recv-conn").textContent = s;
      },
      onTransfer: (s) => {
        $("recv-xfer").textContent = s;
        btn("btn-cancel-recv").disabled = !(s === "receiving");
      },
      onProgress: (p) => {
        ($("recv-bar") as HTMLElement).style.width = `${p.percent.toFixed(1)}%`;
        $("recv-stats").textContent =
          `${fmtBytes(p.bytesTransferred)} / ${fmtBytes(p.totalBytes)} (${p.percent.toFixed(1)}%) · ${fmtSpeed(p.speedBps)} · ETA ${fmtEta(p.etaSec)}`;
      },
      onMetadata: (m) => {
        $("recv-stats").textContent = `receiving ${m.fileName} (${fmtBytes(m.fileSize)}, ${m.totalChunks} chunks)…`;
      },
      onComplete: (file, meta) => {
        const url = toDownloadUrl(file, meta.mimeType);
        const a = $("download-link") as HTMLAnchorElement;
        a.href = url;
        a.download = meta.fileName;
        a.style.display = "inline-block";
        $("recv-stats").textContent += " ✓ checksum OK";
      },
      onError: (e) => {
        $("recv-err").textContent = e.message;
      },
      onCancelled: (r) => {
        $("recv-err").textContent = `cancelled: ${r ?? ""}`;
      },
    });
    area("answer-out").value = "gathering ICE…";
    area("answer-out").value = await acceptOfferAndMakeAnswer(receiver.pc, area("offer-in").value);
  } catch (e) {
    $("recv-err").textContent = e instanceof Error ? e.message : String(e);
  }
});

btn("btn-cancel-recv").addEventListener("click", () => receiver?.cancel("receiver cancelled"));
btn("btn-copy-answer").addEventListener("click", () => void navigator.clipboard.writeText(area("answer-out").value));
