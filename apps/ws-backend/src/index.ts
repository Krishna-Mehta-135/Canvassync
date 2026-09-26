import "@repo/backend-common/config";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import {
  subscribeDurableRoomEvents,
  subscribeRoomPersistJobs,
} from "@repo/queue-sync";
import { RABBITMQ_URL } from "@repo/backend-common/config";
import { checkUser } from "./ws/auth.js";
import {
  activeRooms,
  applyRemotePresenceState,
  broadcastRoomPresenceState,
  broadcastToRoomAll,
  broadcastToRoomUsers,
  leaveActiveRoom,
  registerUser,
  removeRoomPresence,
  removeUserSocket,
  getVoiceParticipants,
  setRoomTimer,
  setVoiceParticipant,
} from "./ws/connectionState.js";
import { handleSocketMessage } from "./ws/messageHandler.js";
import {
  cacheRoomSyncState,
  persistShapes,
  roomCrdtTombstones,
  roomSyncState,
} from "./ws/roomSync.js";
import {
  NODE_ID,
  publishEphemeralEvent,
  subscribeChatEvents,
  subscribePresenceEvents,
  subscribeRoomEvents,
} from "@repo/redis-sync";
import type { AuthenticatedWebSocket } from "./ws/types.js";
import type { ServerMessage } from "@repo/common";
import type { RoomSnapshotBroadcastEvent } from "@repo/common/ws-protocol";
import {
  recordCrossNodeVersionRegression,
  recordDuplicateCrossNodeEvent,
  recordConnectionClosed,
  recordConnectionOpened,
  recordDurableEventConsumed,
  recordInboundMessage,
  recordRedisFanoutEvent,
  startMetricsReporter,
} from "./ws/metrics.js";

const WS_PORT = Number(process.env.WS_PORT ?? 8081);
const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200);
    res.end("OK");
    return;
  }
  res.writeHead(404);
  res.end();
});
const wss = new WebSocketServer({ server });
const RABBITMQ_INITIAL_RETRY_DELAY_MS = Number(
  process.env.WS_RABBITMQ_RETRY_INITIAL_MS ?? 2000,
);
const RABBITMQ_MAX_RETRY_DELAY_MS = Number(
  process.env.WS_RABBITMQ_RETRY_MAX_MS ?? 30000,
);
const WS_ENABLE_DURABLE_QUEUE = process.env.WS_ENABLE_DURABLE_QUEUE !== "false";
const WS_DEBUG_ERRORS = process.env.WS_DEBUG_ERRORS === "true";
let durableEventRetryAttempt = 0;
let persistRetryAttempt = 0;

function nextRetryDelayMs(attempt: number) {
  const boundedAttempt = Math.max(1, attempt);
  const exponentialDelay =
    RABBITMQ_INITIAL_RETRY_DELAY_MS * Math.pow(2, boundedAttempt - 1);
  return Math.min(RABBITMQ_MAX_RETRY_DELAY_MS, exponentialDelay);
}

function shouldLogRetry(attempt: number) {
  return attempt === 1 || attempt % 5 === 0;
}

function safeRabbitMqUrl(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) {
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return "invalid-rabbitmq-url";
  }
}

server.listen(WS_PORT, () => {
  console.log(`WebSocket server online on port ${WS_PORT}`);
});
startMetricsReporter();

const seenActionIds = new Map<string, number>();
const ACTION_ID_TTL_MS = 2 * 60 * 1000;

function rememberAction(actionId: string) {
  seenActionIds.set(actionId, Date.now());
}

function hasSeenAction(actionId: string) {
  const seenAt = seenActionIds.get(actionId);
  if (!seenAt) {
    return false;
  }

  if (Date.now() - seenAt > ACTION_ID_TTL_MS) {
    seenActionIds.delete(actionId);
    return false;
  }

  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [actionId, seenAt] of seenActionIds) {
    if (now - seenAt > ACTION_ID_TTL_MS) {
      seenActionIds.delete(actionId);
    }
  }
}, ACTION_ID_TTL_MS).unref();

async function applyCrossNodeRoomEvent(
  event: RoomSnapshotBroadcastEvent,
  source: "redis" | "rabbitmq",
) {
  if (event.originNodeId === NODE_ID) {
    return;
  }

  if (hasSeenAction(event.actionId)) {
    recordDuplicateCrossNodeEvent();
    return;
  }

  rememberAction(event.actionId);

  const cachedState = roomSyncState.get(event.roomId);
  if (cachedState && event.version <= cachedState.version) {
    recordCrossNodeVersionRegression();
    return;
  }

  if (cachedState && event.version > cachedState.version + 1) {
    // We can still apply because events carry full snapshots, but this
    // indicates transport lag or a missed intermediate version.
    recordCrossNodeVersionRegression();
  }

  cacheRoomSyncState({
    roomId: event.roomId,
    version: event.version,
    shapes: event.shapes,
  });
  if (event.deletionMeta && event.deletedShapeIds) {
    const tombstones =
      roomCrdtTombstones.get(event.roomId) ??
      new Map<string, { clock: number; clientId: string }>();
    for (const id of event.deletedShapeIds) {
      tombstones.set(id, event.deletionMeta);
    }
    roomCrdtTombstones.set(event.roomId, tombstones);
  }

  if (source === "rabbitmq") {
    recordDurableEventConsumed();
  } else {
    recordRedisFanoutEvent(Math.max(0, Date.now() - event.publishedAtMs));
  }

  const localRoomSockets = activeRooms.get(event.roomId);
  if (!localRoomSockets || localRoomSockets.size === 0) {
    return;
  }

  const message: ServerMessage = {
    type: event.type,
    roomId: event.roomId,
    version: event.version,
    shapes: event.shapes,
    senderId: event.senderId ?? "unknown",
    actionId: event.actionId,
    deletedShapeIds: event.deletedShapeIds,
    deletionMeta: event.deletionMeta,
  };

  broadcastToRoomAll(event.roomId, message);
}

// Cross-node room events use a hybrid transport:
// - RabbitMQ durable queue for replay and reliability.
// - Redis Pub/Sub fallback for low-latency best-effort fan-out.
void subscribeRoomEvents(async (event) => {
  await applyCrossNodeRoomEvent(event, "redis");
});

void subscribePresenceEvents(async (event) => {
  if (event.type === "ephemeral_broadcast") {
    if (event.event.kind === "timer") {
      setRoomTimer(
        event.roomId,
        event.event.remainingMs === null
          ? null
          : {
              endsAt: Date.now() + event.event.remainingMs,
              label: event.event.label,
              senderId: event.senderId,
              senderName: event.senderName,
            },
      );
    }
    if (event.event.kind === "voice") {
      setVoiceParticipant(
        event.roomId,
        event.senderId,
        event.senderName,
        event.event.on,
      );
    }
    const relayed = {
      type: "ephemeral_broadcast" as const,
      roomId: event.roomId,
      senderId: event.senderId,
      senderName: event.senderName,
      event: event.event,
    };
    if (event.event.kind === "rtc") {
      // Only the addressee (if connected to this node) receives signaling.
      broadcastToRoomUsers(event.roomId, relayed, [event.event.to]);
    } else {
      broadcastToRoomAll(event.roomId, relayed);
    }
    return;
  }

  applyRemotePresenceState(
    event.roomId,
    event.presences,
    event.connectedUsersCount,
  );
});

void subscribeChatEvents(async (event) => {
  if (event.kind === "direct" && event.recipientIds) {
    broadcastToRoomUsers(
      event.roomId,
      {
        type: "chat_message_created",
        message: event.message,
      },
      event.recipientIds,
    );
  } else {
    broadcastToRoomAll(event.roomId, {
      type: "chat_message_created",
      message: event.message,
    });
  }
});

function startDurableRoomEventConsumer() {
  void subscribeDurableRoomEvents(NODE_ID, async (event) => {
    await applyCrossNodeRoomEvent(event, "rabbitmq");
  })
    .then(() => {
      durableEventRetryAttempt = 0;
    })
    .catch((error) => {
      durableEventRetryAttempt += 1;
      const delayMs = nextRetryDelayMs(durableEventRetryAttempt);

      if (shouldLogRetry(durableEventRetryAttempt)) {
        console.error(
          "[WS] Durable room event consumer unavailable; retrying",
          {
            attempt: durableEventRetryAttempt,
            delayMs,
            rabbitmqUrl: safeRabbitMqUrl(RABBITMQ_URL),
            error,
          },
        );
      }

      setTimeout(() => {
        startDurableRoomEventConsumer();
      }, delayMs).unref();
    });
}

const latestPersistedVersionByRoom = new Map<number, number>();

function startRoomPersistConsumer() {
  void subscribeRoomPersistJobs(async (job) => {
    const knownPersistedVersion =
      latestPersistedVersionByRoom.get(job.roomId) ?? 0;
    if (job.version <= knownPersistedVersion) {
      return;
    }

    await persistShapes(job.roomId, job.shapes);
    latestPersistedVersionByRoom.set(job.roomId, job.version);
  })
    .then(() => {
      persistRetryAttempt = 0;
    })
    .catch((error) => {
      persistRetryAttempt += 1;
      const delayMs = nextRetryDelayMs(persistRetryAttempt);

      if (shouldLogRetry(persistRetryAttempt)) {
        console.error(
          "[WS] Durable DB persist consumer unavailable; retrying",
          {
            attempt: persistRetryAttempt,
            delayMs,
            rabbitmqUrl: safeRabbitMqUrl(RABBITMQ_URL),
            error,
          },
        );
      }

      setTimeout(() => {
        startRoomPersistConsumer();
      }, delayMs).unref();
    });
}

if (WS_ENABLE_DURABLE_QUEUE) {
  startDurableRoomEventConsumer();
  startRoomPersistConsumer();
} else {
  console.warn(
    "[WS] Durable RabbitMQ consumers disabled (WS_ENABLE_DURABLE_QUEUE=false)",
  );
}

wss.on("connection", function connection(ws: AuthenticatedWebSocket, request) {
  const authUser = checkUser(request);

  if (!authUser) {
    ws.close(1008, "Authentication failed");
    return;
  }

  const { userId, userName } = authUser;
  recordConnectionOpened();

  registerUser(userId, ws);
  ws.userName = userName ?? `User ${userId.slice(0, 6)}`;

  // Ping/pong for connection health.
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000);

  // Preserve in-order processing per socket. This avoids version-race
  // mismatches when clients pipeline multiple snapshot messages.
  let messageQueue = Promise.resolve();

  ws.on("message", async (data) => {
    const bytes =
      typeof data === "string"
        ? Buffer.byteLength(data)
        : Buffer.byteLength(data as Buffer);
    recordInboundMessage(bytes);

    messageQueue = messageQueue
      .then(async () => {
        await handleSocketMessage(ws, userId, data);
      })
      .catch((error) => {
        if (WS_DEBUG_ERRORS) {
          console.error("Invalid message", error);
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "sync_error",
              reason: "Invalid message format",
            }),
          );
        }
      });
  });

  ws.on("close", () => {
    recordConnectionClosed();
    clearInterval(pingInterval);
    removeUserSocket(ws);

    if (ws.currentRoomId) {
      const roomId = ws.currentRoomId;
      const didUserFullyLeave = leaveActiveRoom(roomId, ws);

      if (didUserFullyLeave && ws.userId) {
        removeRoomPresence(roomId, ws.userId);
        broadcastRoomPresenceState(roomId);

        // Dropped connections must not leave a ghost in the voice call.
        const name = ws.userName ?? `User ${ws.userId.slice(0, 6)}`;
        const leavingUserId = ws.userId;
        const wasInVoice = getVoiceParticipants(roomId).some(
          (participant) => participant.userId === leavingUserId,
        );
        if (!wasInVoice) return;
        setVoiceParticipant(roomId, ws.userId, name, false);
        const left = {
          type: "ephemeral_broadcast" as const,
          roomId,
          senderId: ws.userId,
          senderName: name,
          event: { kind: "voice" as const, on: false },
        };
        broadcastToRoomAll(roomId, left);
        void publishEphemeralEvent(roomId, {
          senderId: ws.userId,
          senderName: name,
          event: left.event,
        }).catch(() => undefined);
      }
    }
  });

  ws.on("pong", () => {
    // Connection is alive.
  });
});
