/**
 * WebSocket signaling server.
 *
 * Responsibilities ONLY:
 *  - create / join / leave private rooms
 *  - relay OFFER / ANSWER / ICE_CANDIDATE between room peers
 *  - broadcast presence (PEER_JOINED / PEER_LEFT) + transfer state
 *    (TRANSFER_READY / TRANSFER_COMPLETE headers only)
 *  - expire inactive rooms, drop dead sockets, rate-limit clients
 *
 * It never accepts binary frames and never stores or proxies file bytes.
 */
import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { LIMITS, validateClientMessage, type ClientMessage, type ServerMessage } from "./protocol.js";
import { RoomManager, RoomError, newClientId } from "./rooms.js";
import { RateLimiter, CreateRoomLimiter } from "./rateLimiter.js";

export interface SignalingOptions {
  port?: number;
  /** Room time-to-live in ms (default 30 min). */
  roomTtlMs?: number;
  /** Expiry sweep interval in ms. */
  sweepMs?: number;
  /** Default max peers per room. */
  defaultMaxPeers?: number;
  /** Heartbeat interval in ms. */
  heartbeatMs?: number;
}

interface SocketState {
  ws: WebSocket;
  clientId: string;
  limiter: RateLimiter;
  createLimiter: CreateRoomLimiter;
  alive: boolean;
  roomId: string | null;
}

export interface SignalingServer {
  httpServer: HttpServer;
  wss: WebSocketServer;
  rooms: RoomManager;
  port: number;
  close: () => Promise<void>;
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendError(ws: WebSocket, code: string, message: string, requestId?: string): void {
  send(ws, { type: "ERROR", code, message, ...(requestId ? { requestId } : {}) });
}

export async function createSignalingServer(opts: SignalingOptions = {}): Promise<SignalingServer> {
  const roomTtlMs = opts.roomTtlMs ?? 30 * 60 * 1000;
  const sweepMs = opts.sweepMs ?? 30_000;
  const defaultMaxPeers = opts.defaultMaxPeers ?? 2;
  const heartbeatMs = opts.heartbeatMs ?? 30_000;

  const rooms = new RoomManager();
  const sockets = new Map<WebSocket, SocketState>();

  const httpServer = createServer((req, res) => {
    if (req.url === "/healthz") {
      const s = rooms.stats();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...s, uptimeSec: Math.floor(process.uptime()) }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  });

  const wss = new WebSocketServer({ server: httpServer, maxPayload: LIMITS.MAX_MESSAGE_BYTES });

  wss.on("connection", (ws: WebSocket) => {
    const state: SocketState = {
      ws,
      clientId: newClientId(),
      limiter: new RateLimiter({ capacity: 30, refillPerSec: 5 }),
      createLimiter: new CreateRoomLimiter(),
      alive: true,
      roomId: null,
    };
    sockets.set(ws, state);
    send(ws, { type: "WELCOME", clientId: state.clientId });

    ws.on("pong", () => {
      state.alive = true;
    });

    ws.on("message", (raw: RawData, isBinary: boolean) => {
      if (isBinary) {
        sendError(ws, "PAYLOAD_TOO_LARGE", "binary frames are rejected; signaling is JSON text only");
        return;
      }
      const text = raw.toString();
      if (text.length > LIMITS.MAX_MESSAGE_BYTES) {
        sendError(ws, "PAYLOAD_TOO_LARGE", `message exceeds ${LIMITS.MAX_MESSAGE_BYTES} bytes`);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        sendError(ws, "INVALID_JSON", "message is not valid JSON");
        return;
      }
      const reason = validateClientMessage(parsed);
      if (reason) {
        const code = reason.startsWith("unknown message type") ? "UNKNOWN_TYPE" : "VALIDATION_ERROR";
        const requestId =
          typeof parsed === "object" && parsed !== null && typeof (parsed as Record<string, unknown>).requestId === "string"
            ? ((parsed as Record<string, unknown>).requestId as string)
            : undefined;
        sendError(ws, code, reason, requestId);
        return;
      }
      const msg = parsed as ClientMessage;

      if (msg.type === "CREATE_ROOM") {
        if (!state.createLimiter.tryConsume()) {
          sendError(ws, "RATE_LIMITED", "too many rooms created; slow down", msg.requestId);
          return;
        }
        if (!state.limiter.tryConsume()) {
          sendError(ws, "RATE_LIMITED", "slow down", msg.requestId);
          return;
        }
        // Client-supplied ttlSec is clamped to the protocol range;
        // the server-configured default (roomTtlMs) is honored as-is so
        // operators/tests can run short TTLs.
        const ttlMs =
          msg.ttlSec !== undefined
            ? Math.min(Math.max(msg.ttlSec * 1000, 60_000), 4 * 3600 * 1000)
            : roomTtlMs;
        const room = rooms.createRoom({ maxPeers: msg.maxPeers ?? defaultMaxPeers, ttlMs });
        send(ws, {
          type: "ROOM_CREATED",
          room: room.id,
          expiresAt: room.expiresAt,
          maxPeers: room.maxPeers,
          ...(msg.requestId ? { requestId: msg.requestId } : {}),
        });
        return;
      }

      // Every other message type is rate-limited uniformly.
      if (!state.limiter.tryConsume()) {
        const reqId = "requestId" in msg ? (msg.requestId as string | undefined) : undefined;
        sendError(ws, "RATE_LIMITED", "slow down", reqId);
        return;
      }

      handleClientMessage(state, msg);
    });

    const onGone = (reason: string) => {
      sockets.delete(ws);
      const left = rooms.leaveRoom(state.clientId);
      if (left && !left.emptied) {
        broadcast(left.room.id, { type: "PEER_LEFT", room: left.room.id, peer: state.clientId, reason }, null);
      }
      state.roomId = null;
    };
    ws.on("close", () => onGone("disconnect"));
    ws.on("error", () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  });

  function peersIn(roomId: string): SocketState[] {
    const out: SocketState[] = [];
    for (const s of sockets.values()) {
      if (s.roomId === roomId && s.ws.readyState === WebSocket.OPEN) out.push(s);
    }
    return out;
  }

  function broadcast(roomId: string, msg: ServerMessage, except: string | null): void {
    for (const s of peersIn(roomId)) {
      if (except !== null && s.clientId === except) continue;
      send(s.ws, msg);
    }
  }

  function handleClientMessage(state: SocketState, msg: ClientMessage): void {
    const ws = state.ws;
    switch (msg.type) {
      case "JOIN_ROOM": {
        // Leave previous room (if any) before joining the new one.
        if (state.roomId && state.roomId !== msg.room) {
          const prev = rooms.leaveRoom(state.clientId);
          if (prev && !prev.emptied) {
            broadcast(prev.room.id, { type: "PEER_LEFT", room: prev.room.id, peer: state.clientId, reason: "switched-room" }, state.clientId);
          }
        }
        try {
          const { room, peers } = rooms.joinRoom(msg.room, state.clientId, msg.role);
          state.roomId = room.id;
          send(ws, {
            type: "JOINED",
            room: room.id,
            clientId: state.clientId,
            peers,
            expiresAt: room.expiresAt,
            ...(msg.requestId ? { requestId: msg.requestId } : {}),
          });
          broadcast(room.id, { type: "PEER_JOINED", room: room.id, peer: { clientId: state.clientId, role: msg.role } }, state.clientId);
        } catch (e) {
          if (e instanceof RoomError) sendError(ws, e.code, e.message, msg.requestId);
          else sendError(ws, "VALIDATION_ERROR", "join failed", msg.requestId);
        }
        return;
      }
      case "OFFER":
      case "ANSWER":
      case "ICE_CANDIDATE": {
        if (!state.roomId || state.roomId !== msg.room || !rooms.inRoom(state.clientId, msg.room)) {
          sendError(ws, "NOT_IN_ROOM", "join the room before signaling", msg.requestId);
          return;
        }
        const room = rooms.getRoom(msg.room);
        if (!room) {
          sendError(ws, "ROOM_NOT_FOUND", "room gone", msg.requestId);
          return;
        }
        rooms.touch(room);
        if (msg.type === "OFFER") broadcast(msg.room, { type: "OFFER", room: msg.room, from: state.clientId, sdp: msg.sdp }, state.clientId);
        else if (msg.type === "ANSWER") broadcast(msg.room, { type: "ANSWER", room: msg.room, from: state.clientId, sdp: msg.sdp }, state.clientId);
        else broadcast(msg.room, { type: "ICE_CANDIDATE", room: msg.room, from: state.clientId, candidate: msg.candidate }, state.clientId);
        return;
      }
      case "TRANSFER_READY":
      case "TRANSFER_COMPLETE": {
        if (!state.roomId || state.roomId !== msg.room || !rooms.inRoom(state.clientId, msg.room)) {
          sendError(ws, "NOT_IN_ROOM", "join the room before announcing transfer state", msg.requestId);
          return;
        }
        const room = rooms.getRoom(msg.room);
        if (!room) {
          sendError(ws, "ROOM_NOT_FOUND", "room gone", msg.requestId);
          return;
        }
        rooms.touch(room);
        const { type, room: _room, requestId: _drop, ...rest } = msg;
        void _room;
        void _drop;
        broadcast(msg.room, { type, room: msg.room, from: state.clientId, ...rest } as ServerMessage, state.clientId);
        return;
      }
      case "LEAVE": {
        const left = rooms.leaveRoom(state.clientId);
        state.roomId = null;
        send(ws, { type: "LEFT", room: msg.room });
        if (left && !left.emptied) {
          broadcast(left.room.id, { type: "PEER_LEFT", room: left.room.id, peer: state.clientId, reason: "left" }, state.clientId);
        }
        return;
      }
    }
  }

  const heartbeat = setInterval(() => {
    for (const [ws, s] of sockets) {
      if (!s.alive) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        sockets.delete(ws);
        const left = rooms.leaveRoom(s.clientId);
        if (left && !left.emptied) {
          broadcast(left.room.id, { type: "PEER_LEFT", room: left.room.id, peer: s.clientId, reason: "timeout" }, null);
        }
        continue;
      }
      s.alive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  const sweeper = setInterval(() => {
    rooms.sweepExpired();
  }, sweepMs);
  sweeper.unref?.();

  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  const addr = httpServer.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;

  return {
    httpServer,
    wss,
    rooms,
    port: boundPort,
    close: async () => {
      clearInterval(heartbeat);
      clearInterval(sweeper);
      for (const ws of sockets.keys()) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      wss.close();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
