/**
 * useTransfer — React orchestration over the framework-free transfer engine
 * (`@/lib/transfer`) and signaling client (`@/lib/signaling`).
 *
 * Sender: signaling connect -> create room -> join -> WebRTC offer/answer
 * (trickle ICE) -> send selected files sequentially over one DataChannel.
 * Receiver: join by share code -> answer -> receive files with checksum
 * verification -> object-URL downloads.
 *
 * File bytes only ever travel the DataChannel; signaling carries rooms,
 * SDP/ICE and transfer headers.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  TransferPeer,
  buildMetadata,
  clampChunkSize,
  generateSessionId,
  sha256Hex,
  toDownloadUrl,
} from "@/lib/transfer";
import {
  SignalingClient,
  type IceCandidatePayload,
  type PeerInfo,
  type SdpPayload,
} from "@/lib/signaling";
import { signalingUrl } from "@/lib/config";
import { downloadViaGateway, gatewayBase, getWebManifest } from "@/lib/rust";
import {
  defaultRtcNetConfig,
  fetchTurnGrant,
  withTurnServers,
  wsToHttpBase,
  type RouteKind,
  type RtcNetConfig,
} from "@/lib/transfer";

export type TransferPhase =
  | "idle"
  | "file-selected"
  | "creating-session"
  | "waiting-for-peer"
  | "peer-connected"
  | "connecting"
  | "transferring"
  | "paused"
  | "failed"
  | "completed";

export type LinkStatus = "offline" | "link" | "live" | "failed";

export interface ActiveFileProgress {
  bytesTransferred: number;
  totalBytes: number;
  percent: number;
  speedBps: number;
  etaSec: number;
  fileName: string;
  fileIndex: number;
  fileTotal: number;
}

export interface ReceivedFile {
  id: string;
  name: string;
  size: number;
  mime: string;
  url: string;
}

const CHUNK_SIZE = clampChunkSize(64 * 1024);

async function setRemote(peer: TransferPeer, sdp: SdpPayload): Promise<void> {
  await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp as RTCSessionDescriptionInit));
}

export function useTransfer() {
  const [phase, setPhase] = useState<TransferPhase>("idle");
  const [link, setLink] = useState<LinkStatus>("offline");
  const [sessionCode, setSessionCode] = useState<string | null>(null);
  const [role, setRole] = useState<"sender" | "receiver" | null>(null);
  const [progress, setProgress] = useState<ActiveFileProgress | null>(null);
  const [received, setReceived] = useState<ReceivedFile[]>([]);
  const [failure, setFailure] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [paused, setPaused] = useState(false);
  const [source, setSource] = useState<"p2p" | "gateway" | null>(null);
  const [route, setRoute] = useState<RouteKind>("unknown");

  const peerRef = useRef<TransferPeer | null>(null);
  const sigRef = useRef<SignalingClient | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef(0);
  const pendingIceRef = useRef<IceCandidatePayload[]>([]);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartAttemptsRef = useRef(0);
  const lastActionRef = useRef<
    { kind: "send"; files: File[] } | { kind: "join"; code: string } | null
  >(null);

  const stopTimers = useCallback(() => {
    if (statsTimerRef.current) {
      clearInterval(statsTimerRef.current);
      statsTimerRef.current = null;
    }
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  const teardown = useCallback(() => {
    runRef.current += 1; // invalidate all in-flight async continuations
    pendingIceRef.current = [];
    stopTimers();
    restartAttemptsRef.current = 0;
    try {
      abortRef.current?.abort();
    } catch {
      /* ignore */
    }
    abortRef.current = null;
    try {
      peerRef.current?.close();
    } catch {
      /* ignore */
    }
    peerRef.current = null;
    try {
      sigRef.current?.close();
    } catch {
      /* ignore */
    }
    sigRef.current = null;
  }, [stopTimers]);

  useEffect(() => teardown, [teardown]);

  const fail = useCallback(
    (run: number, msg: string) => {
      if (runRef.current !== run) return;
      stopTimers();
      setNotice(null);
      setFailure(msg);
      setPhase("failed");
      setLink("failed");
    },
    [stopTimers],
  );

  /** Connect with bounded retries; surfaces "retrying" status, fails cleanly. */
  const connectSignaling = useCallback(
    async (run: number, sig: SignalingClient): Promise<boolean> => {
      try {
        await sig.connectWithRetry({
          attempts: 3,
          isCurrent: () => runRef.current === run,
          onAttempt: (n, max) => {
            if (runRef.current !== run) return;
            setNotice(n > 1 ? `Retrying signaling connection… (attempt ${n}/${max})` : null);
          },
        });
        if (runRef.current !== run) return false;
        setNotice(null);
        return true;
      } catch {
        return false;
      }
    },
    [],
  );

  const trackPeers = useCallback(
    (run: number) => ({
      onPeers: (list: PeerInfo[]) => {
        if (runRef.current === run) setPeers(list);
      },
      onPeerJoined: (peer: PeerInfo) => {
        if (runRef.current !== run) return;
        setPeers((cur) => (cur.some((p) => p.clientId === peer.clientId) ? cur : [...cur, peer]));
      },
      onPeerLeft: (id: string) => {
        if (runRef.current === run) setPeers((cur) => cur.filter((p) => p.clientId !== id));
      },
    }),
    [],
  );

  const flushIce = useCallback(async (peer: TransferPeer) => {
    const queued = pendingIceRef.current.splice(0);
    for (const c of queued) {
      try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(c as RTCIceCandidateInit));
      } catch {
        /* stale candidate */
      }
    }
  }, []);

  const rememberIce = useCallback(async (peer: TransferPeer, candidate: IceCandidatePayload) => {
    try {
      if (peer.pc.remoteDescription) {
        await peer.pc.addIceCandidate(new RTCIceCandidate(candidate as RTCIceCandidateInit));
      } else {
        pendingIceRef.current.push(candidate);
      }
    } catch {
      /* ignore malformed candidates */
    }
  }, []);

  const forwardLocalIce = useCallback((peer: TransferPeer, sig: SignalingClient) => {
    peer.pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      try {
        sig.sendIce({
          candidate: ev.candidate.candidate,
          sdpMid: ev.candidate.sdpMid,
          sdpMLineIndex: ev.candidate.sdpMLineIndex,
        });
      } catch {
        /* room not joined yet */
      }
    };
  }, []);

  /**
   * Best-effort network config: STUN always, TURN grant when the
   * signaling service has it configured. Resolves fast on failure so a
   * missing TURN server never blocks a direct attempt.
   */
  const buildNetConfig = useCallback(async (): Promise<RtcNetConfig> => {
    const base = defaultRtcNetConfig();
    try {
      const grant = await fetchTurnGrant(wsToHttpBase(signalingUrl()));
      return withTurnServers(base, grant);
    } catch {
      return base;
    }
  }, []);

  /** Poll getStats while a session is live; peer emits onRoute on change. */
  const startRoutePolling = useCallback((run: number, peer: TransferPeer, intervalMs: number) => {
    if (statsTimerRef.current) clearInterval(statsTimerRef.current);
    if (!intervalMs || intervalMs <= 0) return;
    const tick = () => {
      if (runRef.current !== run) {
        if (statsTimerRef.current) clearInterval(statsTimerRef.current);
        statsTimerRef.current = null;
        return;
      }
      void peer.getRouteInfo().catch(() => undefined);
    };
    void tick();
    statsTimerRef.current = setInterval(tick, intervalMs);
  }, []);

  // ---------------- sender ----------------

  const startSend = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      teardown();
      const run = runRef.current;
      setReceived([]);
      setProgress(null);
      setFailure("");
      setNotice(null);
      setPeers([]);
      setPaused(false);
      setRole("sender");
      setSource("p2p");
      setRoute("unknown");
      setPhase("creating-session");
      setLink("link");
      lastActionRef.current = { kind: "send", files };

      const net = await buildNetConfig();
      if (runRef.current !== run) return;

      const peer = new TransferPeer(
        "sender",
        {
          onConnection: (s) => {
            if (runRef.current !== run) return;
            if (s === "failed") {
              fail(run, "Peer connection failed (no direct or relay path — is TURN configured?).");
            } else if (s === "connected") setLink("live");
            else if (s === "disconnected") scheduleIceRestart();
          },
          onTransfer: (s) => {
            if (runRef.current !== run) return;
            if (s === "idle") {
              // DataChannel opened -> peer is connected, start the queue.
              setPhase("peer-connected");
              void sendQueue();
            } else if (s === "error") {
              fail(run, "Transfer error. The peer may have disconnected.");
            }
          },
          onProgress: (p) => {
            if (runRef.current !== run) return;
            setProgress((cur) =>
              cur
                ? {
                    ...p,
                    fileName: cur.fileName,
                    fileIndex: cur.fileIndex,
                    fileTotal: cur.fileTotal,
                  }
                : cur,
            );
          },
          onRoute: (kind) => {
            if (runRef.current === run) setRoute(kind);
          },
          onError: (e) => fail(run, e.message),
        },
        {
          iceServers: net.iceServers,
          connectionTimeoutMs: net.connectionTimeoutMs,
          backpressureBytes: net.backpressureBytes,
          resumeWaitMs: net.resumeWaitMs,
        },
      );
      peerRef.current = peer;
      startRoutePolling(run, peer, net.statsPollMs);

      const tp = trackPeers(run);
      const sig = new SignalingClient(signalingUrl(), {
        ...tp,
        onPeerJoined: (p) => {
          tp.onPeerJoined(p);
          void makeOffer();
        },
        onAnswer: (_from, sdp) => {
          void (async () => {
            try {
              await setRemote(peer, sdp);
              await flushIce(peer);
              if (runRef.current === run) setPhase("connecting");
            } catch {
              fail(run, "Could not complete the handshake.");
            }
          })();
        },
        onIce: (_from, candidate) => void rememberIce(peer, candidate),
        onPeerLeft: () => fail(run, "Peer left the session."),
        onErrorMsg: (code, message) => fail(run, `${code}: ${message}`),
      });
      sigRef.current = sig;
      forwardLocalIce(peer, sig);

      let offerSent = false;
      let roomCode = "";
      const makeOffer = async (restart = false) => {
        if (runRef.current !== run) return;
        if (offerSent && !restart) return;
        offerSent = true;
        try {
          if (restart) peer.pc.restartIce();
          const offer = await peer.pc.createOffer(restart ? { iceRestart: true } : undefined);
          await peer.pc.setLocalDescription(offer);
          sig.sendOffer({ type: "offer", sdp: offer.sdp ?? "" });
          peer.armConnectionTimeout();
          if (runRef.current === run) setPhase("waiting-for-peer");
        } catch {
          fail(run, "Could not start the peer connection.");
        }
      };

      // Transient interruption: give ICE one more chance (up to 2
      // restarts) before failing. The receiver re-answers automatically.
      const scheduleIceRestart = () => {
        if (runRef.current !== run || restartAttemptsRef.current >= 2) return;
        if (restartTimerRef.current) return;
        restartTimerRef.current = setTimeout(() => {
          restartTimerRef.current = null;
          if (runRef.current !== run) return;
          if (peer.pc.connectionState !== "disconnected") return;
          restartAttemptsRef.current += 1;
          void makeOffer(true);
        }, 5000);
      };

      const sendQueue = async () => {
        try {
          for (let i = 0; i < files.length; i++) {
            const file = files[i] as File;
            if (runRef.current !== run) return;
            setPhase("transferring");
            setProgress({
              bytesTransferred: 0,
              totalBytes: file.size,
              percent: 0,
              speedBps: 0,
              etaSec: Infinity,
              fileName: file.name,
              fileIndex: i,
              fileTotal: files.length,
            });
            const checksum = await sha256Hex(new Uint8Array(await file.arrayBuffer()));
            if (runRef.current !== run) return;
            const meta = buildMetadata({
              transferId: generateSessionId(),
              fileName: file.name,
              fileSize: file.size,
              mimeType: file.type,
              chunkSize: CHUNK_SIZE,
              checksum,
            });
            try {
              sig.announceReady({
                transferId: meta.transferId,
                fileName: meta.fileName,
                fileSize: meta.fileSize,
                chunks: meta.totalChunks,
              });
            } catch {
              /* best effort */
            }
            await peer.sendFile(meta, file);
            if (runRef.current !== run) return;
          }
          try {
            sig.announceComplete({ transferId: roomCode || "done" });
          } catch {
            /* best effort */
          }
          if (runRef.current === run) {
            stopTimers();
            setPhase("completed");
            setLink("live");
          }
        } catch (e) {
          if (runRef.current !== run) return;
          const msg = e instanceof Error ? e.message : String(e);
          if (msg !== "cancelled") fail(run, msg);
        }
      };

      try {
        if (!(await connectSignaling(run, sig))) {
          fail(
            run,
            "Could not reach the signaling service. Check the URL and network, then try again.",
          );
          return;
        }
        if (runRef.current !== run) return;
        const { room } = await sig.createRoom();
        if (runRef.current !== run) return;
        roomCode = room;
        setSessionCode(room);
        const peers = await sig.join(room, "sender");
        if (runRef.current !== run) return;
        if (peers.length > 0) void makeOffer();
        else setPhase("waiting-for-peer");
      } catch (e) {
        fail(run, e instanceof Error ? e.message : "Could not create a session. Try again.");
      }
    },
    [
      buildNetConfig,
      connectSignaling,
      fail,
      flushIce,
      forwardLocalIce,
      rememberIce,
      startRoutePolling,
      stopTimers,
      teardown,
      trackPeers,
    ],
  );

  // ---------------- receiver ----------------

  const joinWithCode = useCallback(
    async (code: string) => {
      const room = code.trim().toUpperCase();
      if (!room) return;
      teardown();
      const run = runRef.current;
      setReceived([]);
      setProgress(null);
      setFailure("");
      setNotice(null);
      setPeers([]);
      setPaused(false);
      setRole("receiver");
      setSource("p2p");
      setRoute("unknown");
      setSessionCode(room);
      setPhase("connecting");
      setLink("link");
      lastActionRef.current = { kind: "join", code: room };

      const net = await buildNetConfig();
      if (runRef.current !== run) return;

      const peer = new TransferPeer(
        "receiver",
        {
          onConnection: (s) => {
            if (runRef.current !== run) return;
            if (s === "failed") {
              fail(run, "Peer connection failed (no direct or relay path — is TURN configured?).");
            } else if (s === "connected") setLink("live");
            // Note: transient "disconnected" needs no local action here —
            // the sender ICE-restarts and this side re-answers its offer.
          },
          onRoute: (kind) => {
            if (runRef.current === run) setRoute(kind);
          },
          onMetadata: (m) => {
            if (runRef.current !== run) return;
            setPhase("transferring");
            setProgress({
              bytesTransferred: 0,
              totalBytes: m.fileSize,
              percent: 0,
              speedBps: 0,
              etaSec: Infinity,
              fileName: m.fileName,
              fileIndex: 0,
              fileTotal: 1,
            });
          },
          onProgress: (p) => {
            if (runRef.current !== run) return;
            setProgress((cur) =>
              cur
                ? {
                    ...p,
                    fileName: cur.fileName,
                    fileIndex: cur.fileIndex,
                    fileTotal: cur.fileTotal,
                  }
                : cur,
            );
          },
          onComplete: (file, meta) => {
            if (runRef.current !== run) return;
            const url = toDownloadUrl(file, meta.mimeType);
            setReceived((cur) => [
              ...cur,
              {
                id: `${meta.transferId}-${meta.fileName}`,
                name: meta.fileName,
                size: meta.fileSize,
                mime: meta.mimeType,
                url,
              },
            ]);
          },
          onTransfer: (s) => {
            if (s === "error" && runRef.current === run) {
              fail(run, "Transfer error. The peer may have disconnected.");
            }
          },
          onError: (e) => fail(run, e.message),
        },
        {
          iceServers: net.iceServers,
          connectionTimeoutMs: net.connectionTimeoutMs,
          backpressureBytes: net.backpressureBytes,
          resumeWaitMs: net.resumeWaitMs,
        },
      );
      peerRef.current = peer;
      startRoutePolling(run, peer, net.statsPollMs);

      const tp = trackPeers(run);
      const sig = new SignalingClient(signalingUrl(), {
        ...tp,
        onOffer: (_from, sdp) => {
          void (async () => {
            try {
              await setRemote(peer, sdp);
              await flushIce(peer);
              const answer = await peer.pc.createAnswer();
              await peer.pc.setLocalDescription(answer);
              sig.sendAnswer({ type: "answer", sdp: answer.sdp ?? "" });
            } catch {
              fail(run, "Could not answer the handshake.");
            }
          })();
        },
        onIce: (_from, candidate) => void rememberIce(peer, candidate),
        onTransferComplete: () => {
          if (runRef.current === run) {
            stopTimers();
            setPhase("completed");
            setLink("live");
          }
        },
        onPeerLeft: (id) => {
          if (runRef.current !== run) return;
          tp.onPeerLeft(id);
          setReceived((cur) => {
            if (cur.length === 0) fail(run, "Peer left before sending anything.");
            else {
              setPhase("completed");
              setLink("live");
            }
            return cur;
          });
        },
        onErrorMsg: (code, message) => fail(run, `${code}: ${message}`),
      });
      sigRef.current = sig;
      forwardLocalIce(peer, sig);

      try {
        if (!(await connectSignaling(run, sig))) {
          fail(
            run,
            "Could not reach the signaling service. Check the URL and network, then try again.",
          );
          return;
        }
        if (runRef.current !== run) return;
        await sig.join(room, "receiver");
        if (runRef.current !== run) return;
        peer.armConnectionTimeout();
        setPhase("waiting-for-peer");
      } catch (e) {
        fail(run, e instanceof Error ? e.message : "Could not join the session. Check the code.");
      }
    },
    [
      buildNetConfig,
      connectSignaling,
      fail,
      flushIce,
      forwardLocalIce,
      rememberIce,
      startRoutePolling,
      stopTimers,
      teardown,
      trackPeers,
    ],
  );

  // ---------------- gateway fallback (deliberate HTTP relay) ----------------

  /**
   * Deliberate fallback when no WebRTC channel exists: fetch the web
   * manifest from a Rust gateway, then stored chunks one by one with
   * SHA-256 verification. Explicit user choice — never silent.
   */
  const fetchFromGateway = useCallback(
    async (fileId: string, apiBase?: string) => {
      const id = fileId.trim();
      if (!id) return;
      teardown();
      const run = runRef.current;
      const base = (apiBase?.trim() || gatewayBase()).replace(/\/+$/, "");
      setReceived([]);
      setProgress(null);
      setFailure("");
      setPaused(false);
      setRole("receiver");
      setSource("gateway");
      setSessionCode(null);
      setPhase("connecting");
      setLink("link");

      const abort = new AbortController();
      abortRef.current = abort;
      try {
        const manifest = await getWebManifest(base, id, abort.signal);
        if (runRef.current !== run) return;
        setPhase("transferring");
        const t0 = Date.now();
        const data = await downloadViaGateway(base, manifest, {
          signal: abort.signal,
          onProgress: (bytes, total) => {
            if (runRef.current !== run) return;
            const elapsed = Math.max(1, Date.now() - t0) / 1000;
            const speedBps = bytes / elapsed;
            setProgress({
              bytesTransferred: bytes,
              totalBytes: total,
              percent: total === 0 ? 100 : (bytes / total) * 100,
              speedBps,
              etaSec: speedBps > 0 ? (total - bytes) / speedBps : Infinity,
              fileName: manifest.file_name,
              fileIndex: 0,
              fileTotal: 1,
            });
          },
        });
        if (runRef.current !== run) return;
        stopTimers();
        const url = toDownloadUrl(data, manifest.mime);
        setReceived([
          {
            id: `${manifest.file_id}-${manifest.file_name}`,
            name: manifest.file_name,
            size: manifest.file_size,
            mime: manifest.mime,
            url,
          },
        ]);
        setPhase("completed");
        setLink("live");
      } catch (e) {
        if (runRef.current !== run) return;
        if (e instanceof DOMException && e.name === "AbortError") {
          setFailure("Transfer cancelled.");
        } else {
          setFailure(e instanceof Error ? e.message : "Gateway download failed.");
        }
        setPhase("failed");
        setLink("failed");
      }
    },
    [stopTimers, teardown],
  );

  // ---------------- retry (full rejoin) ----------------

  /**
   * Re-run the last action with a fresh peer + signaling session.
   * Used after failures/timeouts. Note: a retry starts the file queue
   * from the beginning; in-session resumption (have-hints) applies while
   * the same DataChannel session is alive.
   */
  const retry = useCallback(() => {
    const last = lastActionRef.current;
    if (!last) return;
    if (last.kind === "send") void startSend(last.files);
    else void joinWithCode(last.code);
  }, [joinWithCode, startSend]);

  // ---------------- controls ----------------

  const pause = useCallback(() => {
    peerRef.current?.pause();
    setPaused(true);
    setPhase((p) => (p === "transferring" ? "paused" : p));
  }, []);

  const resume = useCallback(() => {
    peerRef.current?.resume();
    setPaused(false);
    setPhase((p) => (p === "paused" ? "transferring" : p));
  }, []);

  const cancel = useCallback(() => {
    try {
      peerRef.current?.cancel("cancelled by user");
    } catch {
      /* ignore */
    }
    teardown();
    setFailure("Transfer cancelled.");
    setNotice(null);
    setPeers([]);
    setPhase("failed");
    setLink("offline");
  }, [teardown]);

  const reset = useCallback(() => {
    setReceived((cur) => {
      for (const r of cur) URL.revokeObjectURL(r.url);
      return [];
    });
    teardown();
    setProgress(null);
    setSessionCode(null);
    setRole(null);
    setSource(null);
    setFailure("");
    setNotice(null);
    setPeers([]);
    setPaused(false);
    setLink("offline");
    setPhase("idle");
  }, [teardown]);

  /**
   * Called by the file picker whenever the selection changes while no
   * session is active. Clears stale transfer artifacts and reflects
   * whether files are selected.
   */
  const selectionChanged = useCallback((hasFiles: boolean) => {
    setReceived((cur) => {
      for (const r of cur) URL.revokeObjectURL(r.url);
      return [];
    });
    setProgress(null);
    setSessionCode(null);
    setRole(null);
    setSource(null);
    setFailure("");
    setNotice(null);
    setPeers([]);
    setPaused(false);
    setLink("offline");
    setPhase(hasFiles ? "file-selected" : "idle");
  }, []);

  return {
    phase,
    link,
    route,
    sessionCode,
    role,
    source,
    progress,
    received,
    failure,
    notice,
    peers,
    paused,
    startSend,
    joinWithCode,
    fetchFromGateway,
    retry,
    pause,
    resume,
    cancel,
    reset,
    selectionChanged,
  };
}
