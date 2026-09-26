import { randomUUID } from "node:crypto";
import { RawData } from "ws";
import type { Shape } from "@repo/canvas-engine";
import { ClientWsMessageSchema } from "@repo/common/ws-protocol";
import {
  mergeCanvasCrdtSnapshot,
  type CanvasCrdtDeletion,
  type PersistedChatMessage,
  type ServerMessage,
} from "@repo/common";
import { prismaClient } from "@repo/db/client";
import type { AuthenticatedWebSocket } from "./types.js";
import { publishDurableRoomEvent } from "@repo/queue-sync";
import {
  broadcastRoomPresenceState,
  broadcastToRoom,
  broadcastToRoomAll,
  broadcastToRoomUsers,
  getRoomPresenceState,
  joinActiveRoom,
  setRoomPresence,
} from "./connectionState.js";
import {
  cacheRoomSyncState,
  enqueueRoomPersist,
  initializeRoomSync,
  roomCrdtTombstones,
  roomSyncState,
} from "./roomSync.js";
import {
  commitRoomSnapshot,
  NODE_ID,
  publishChatEvent,
  publishEphemeralEvent,
} from "@repo/redis-sync";
import {
  recordInvalidJsonPayload,
  recordInvalidMessagePayload,
  recordOversizedMessage,
  recordRateLimitedSnapshot,
  recordSnapshotCommitFailure,
  recordSnapshotCommitted,
  recordDurablePublishFailure,
} from "./metrics.js";

const WS_MAX_MESSAGE_BYTES = Number(
  process.env.WS_MAX_MESSAGE_BYTES ?? 512 * 1024,
);
// Higher default keeps drag/move streams smooth for multi-user sessions while
// still preventing extreme snapshot floods.
const WS_SNAPSHOT_RATE_LIMIT_COUNT = Number(
  process.env.WS_SNAPSHOT_RATE_LIMIT_COUNT ?? 90,
);
const WS_SNAPSHOT_RATE_LIMIT_WINDOW_MS = Number(
  process.env.WS_SNAPSHOT_RATE_LIMIT_WINDOW_MS ?? 1000,
);

// Cursor/reaction traffic is high-frequency but disposable: excess is dropped
// silently rather than surfacing sync errors to the sender.
const WS_EPHEMERAL_RATE_LIMIT_COUNT = Number(
  process.env.WS_EPHEMERAL_RATE_LIMIT_COUNT ?? 60,
);
const WS_EPHEMERAL_RATE_LIMIT_WINDOW_MS = 1000;

const ephemeralRateWindowBySocket = new WeakMap<
  AuthenticatedWebSocket,
  { windowStartMs: number; count: number }
>();

function isEphemeralRateLimited(ws: AuthenticatedWebSocket) {
  const now = Date.now();
  const window = ephemeralRateWindowBySocket.get(ws);
  if (!window || now - window.windowStartMs >= WS_EPHEMERAL_RATE_LIMIT_WINDOW_MS) {
    ephemeralRateWindowBySocket.set(ws, { windowStartMs: now, count: 1 });
    return false;
  }
  window.count += 1;
  return window.count > WS_EPHEMERAL_RATE_LIMIT_COUNT;
}

const snapshotRateWindowBySocket = new WeakMap<
  AuthenticatedWebSocket,
  { windowStartMs: number; count: number }
>();

function rawDataByteLength(data: RawData) {
  if (typeof data === "string") {
    return Buffer.byteLength(data);
  }

  if (Array.isArray(data)) {
    return data.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  }

  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }

  return Buffer.byteLength(data);
}

function isSnapshotRateLimited(ws: AuthenticatedWebSocket) {
  const now = Date.now();
  const existing = snapshotRateWindowBySocket.get(ws);

  if (
    !existing ||
    now - existing.windowStartMs >= WS_SNAPSHOT_RATE_LIMIT_WINDOW_MS
  ) {
    snapshotRateWindowBySocket.set(ws, {
      windowStartMs: now,
      count: 1,
    });
    return false;
  }

  existing.count += 1;
  return existing.count > WS_SNAPSHOT_RATE_LIMIT_COUNT;
}

type RoomRole = "OWNER" | "EDITOR" | "VIEWER";

/** Resolves the user's role in a room, or null when they have no access. */
async function getRoomRole(roomId: number, userId: string): Promise<RoomRole | null> {
  const room = await prismaClient.room.findUnique({
    where: { id: roomId },
    select: {
      adminId: true,
      members: { where: { userId }, select: { role: true } },
    },
  });
  if (!room) return null;
  if (room.adminId === userId) return "OWNER";
  const member = room.members[0];
  return member ? member.role : null;
}

async function hasRoomAccess(roomId: number, userId: string) {
  return (await getRoomRole(roomId, userId)) !== null;
}

const ROLE_RECHECK_MS = 10_000;

/** Whether the socket's user may currently edit; re-reads the DB when the cached role is stale. */
async function canEditRoom(ws: AuthenticatedWebSocket, roomId: number, userId: string) {
  const now = Date.now();
  if (!ws.role || !ws.roleCheckedAtMs || now - ws.roleCheckedAtMs > ROLE_RECHECK_MS) {
    ws.role = (await getRoomRole(roomId, userId)) ?? undefined;
    ws.roleCheckedAtMs = now;
  }
  return ws.role === "OWNER" || ws.role === "EDITOR";
}

function rejectForbidden(ws: AuthenticatedWebSocket) {
  ws.send(
    JSON.stringify({
      type: "sync_error",
      reason: "Forbidden",
    } as ServerMessage),
  );

  ws.close(1008, "Forbidden");
}

function mapChatParticipant(user: {
  id: string;
  name: string;
  handle: string | null;
  photo?: string | null;
}) {
  return {
    id: user.id,
    name: user.name,
    handle: user.handle,
    photo: user.photo ?? null,
  };
}

function mapPersistedChatMessage(chat: {
  id: number;
  roomId: number;
  message: string;
  messageType: "GROUP" | "DIRECT" | "COMMENT";
  shapeId: string | null;
  createdAt: Date;
  user: {
    id: string;
    name: string;
    handle: string | null;
    photo?: string | null;
  };
  recipient: {
    id: string;
    name: string;
    handle: string | null;
    photo?: string | null;
  } | null;
}): PersistedChatMessage {
  return {
    id: chat.id,
    roomId: chat.roomId,
    kind:
      chat.messageType === "DIRECT"
        ? "direct"
        : chat.messageType === "COMMENT"
          ? "comment"
          : "group",
    body: chat.message,
    shapeId: chat.shapeId ?? null,
    createdAt: chat.createdAt.toISOString(),
    sender: mapChatParticipant(chat.user),
    recipient: chat.recipient ? mapChatParticipant(chat.recipient) : null,
  };
}

export async function handleSocketMessage(
  ws: AuthenticatedWebSocket,
  userId: string,
  data: RawData,
) {
  const payloadBytes = rawDataByteLength(data);
  if (payloadBytes > WS_MAX_MESSAGE_BYTES) {
    recordOversizedMessage();
    ws.send(
      JSON.stringify({
        type: "sync_error",
        reason: "Payload exceeds maximum allowed size",
      } as ServerMessage),
    );
    return;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(data.toString());
  } catch {
    recordInvalidJsonPayload();
    ws.send(
      JSON.stringify({
        type: "sync_error",
        reason: "Invalid JSON payload",
      } as ServerMessage),
    );
    return;
  }

  const messageValidation = ClientWsMessageSchema.safeParse(parsedJson);
  if (!messageValidation.success) {
    recordInvalidMessagePayload();
    ws.send(
      JSON.stringify({
        type: "sync_error",
        reason: "Invalid message payload",
      } as ServerMessage),
    );
    return;
  }

  const parsed = messageValidation.data;

  if (parsed.type === "join_room") {
    const roomId = parsed.roomId;

    if (typeof roomId !== "number" || roomId <= 0) {
      ws.send(
        JSON.stringify({
          type: "sync_error",
          reason: "Invalid roomId",
        } as ServerMessage),
      );
      return;
    }

    const role = await getRoomRole(roomId, userId);
    if (!role) {
      rejectForbidden(ws);
      return;
    }
    ws.role = role;
    ws.roleCheckedAtMs = Date.now();

    let roomState;
    try {
      roomState = await initializeRoomSync(roomId);
    } catch (err) {
      console.error("[WS] initializeRoomSync failed", err);
      ws.send(
        JSON.stringify({
          type: "sync_error",
          reason: "Server error, try again",
        } as ServerMessage),
      );
      return;
    }
    const isFirstRoomConnectionForUser = joinActiveRoom(roomId, ws);

    if (isFirstRoomConnectionForUser && ws.userId) {
      setRoomPresence(roomId, ws.userId, {
        userId: ws.userId,
        userName: ws.userName ?? `User ${ws.userId.slice(0, 6)}`,
        cursor: null,
        selectedIds: [],
        tool: null,
      });
    }

    const presenceState = getRoomPresenceState(roomId);

    ws.send(
      JSON.stringify({
        type: "room_joined",
        roomId,
        role,
        version: roomState.version,
        shapes: roomState.shapes,
        userId,
        connectedUsersCount: presenceState.connectedUsersCount,
        presences: presenceState.presences,
      } as ServerMessage),
    );

    broadcastRoomPresenceState(roomId);
    return;
  }

  if (parsed.type === "update_presence") {
    const { roomId, selectedIds } = parsed;

    if (typeof roomId !== "number" || roomId <= 0) {
      ws.send(
        JSON.stringify({
          type: "sync_error",
          reason: "Invalid roomId",
        } as ServerMessage),
      );
      return;
    }

    if (!ws.currentRoomId) {
      ws.send(
        JSON.stringify({
          type: "sync_error",
          reason: "Forbidden",
        } as ServerMessage),
      );
      return;
    }

    if (ws.currentRoomId !== roomId) {
      ws.send(
        JSON.stringify({
          type: "sync_error",
          reason: "Presence update sent for a room that is not active",
        } as ServerMessage),
      );
      return;
    }

    if (!ws.userId) {
      return;
    }

    setRoomPresence(roomId, ws.userId, {
      userId: ws.userId,
      userName: ws.userName ?? `User ${ws.userId.slice(0, 6)}`,
      cursor: parsed.cursor ?? null,
      selectedIds: Array.isArray(selectedIds) ? selectedIds : [],
      tool: typeof parsed.tool === "string" ? parsed.tool : null,
    });

    broadcastRoomPresenceState(roomId);
    return;
  }

  if (parsed.type === "ephemeral") {
    // Must be an active member of the room; otherwise silently ignore.
    if (!ws.userId || ws.currentRoomId !== parsed.roomId) return;
    if (isEphemeralRateLimited(ws)) return;

    const senderName = ws.userName ?? `User ${ws.userId.slice(0, 6)}`;

    broadcastToRoom(
      parsed.roomId,
      {
        type: "ephemeral_broadcast",
        roomId: parsed.roomId,
        senderId: ws.userId,
        senderName,
        event: parsed.event,
      },
      ws,
    );

    void publishEphemeralEvent(parsed.roomId, {
      senderId: ws.userId,
      senderName,
      event: parsed.event,
    }).catch(() => {
      // Best-effort: ephemeral events are not worth retrying.
    });
    return;
  }

  if (parsed.type === "canvas_snapshot") {
    const { roomId, shapes } = parsed;
    const snapshotStartedAtMs = Date.now();
    const actionId = randomUUID();

    if (isSnapshotRateLimited(ws)) {
      recordRateLimitedSnapshot();
      ws.send(
        JSON.stringify({
          type: "sync_error",
          reason: "Snapshot rate limit exceeded. Slow down and retry.",
        } as ServerMessage),
      );
      return;
    }

    if (typeof roomId !== "number" || roomId <= 0) {
      ws.send(
        JSON.stringify({
          type: "sync_error",
          reason: "Invalid roomId",
        } as ServerMessage),
      );
      return;
    }

    if (ws.currentRoomId !== roomId) {
      ws.send(
        JSON.stringify({
          type: "sync_error",
          reason: "Forbidden",
        } as ServerMessage),
      );
      return;
    }

    if (!(await canEditRoom(ws, roomId, userId))) {
      ws.send(
        JSON.stringify({
          type: "sync_error",
          reason: "Read-only: you have view-only access to this room",
        } as ServerMessage),
      );
      return;
    }

    if (!Array.isArray(shapes)) {
      ws.send(
        JSON.stringify({
          type: "sync_error",
          reason: "Shapes must be an array",
        } as ServerMessage),
      );
      return;
    }

    const typedShapes = shapes as Shape[];
    const shapeIds = new Set<string>();
    for (const shape of typedShapes) {
      if (typeof shape.id !== "string") {
        ws.send(
          JSON.stringify({
            type: "sync_error",
            reason: "All shapes must have string IDs",
          } as ServerMessage),
        );
        return;
      }

      if (shapeIds.has(shape.id)) {
        // Deduplicate silently server-side.
      }
      shapeIds.add(shape.id);
    }

    const currentRoomState =
      roomSyncState.get(roomId) ?? (await initializeRoomSync(roomId));
    const deletionMeta = parsed.deletionMeta ?? null;
    const deletions: CanvasCrdtDeletion[] =
      deletionMeta && Array.isArray(parsed.deletedShapeIds)
        ? parsed.deletedShapeIds.map((id) => ({
            id,
            meta: deletionMeta,
          }))
        : [];
    const mergeResult = mergeCanvasCrdtSnapshot(
      currentRoomState.shapes,
      typedShapes,
      deletions,
      roomCrdtTombstones.get(roomId),
    );
    roomCrdtTombstones.set(roomId, mergeResult.tombstones);

    // The commit is atomic in Redis: version bump, snapshot replacement, and
    // cross-node publish all happen as one room transition. CRDT merge uses
    // the latest room version as its base so stale clients can still contribute
    // non-conflicting shape updates instead of being rejected outright.
    const commitStartedAtMs = Date.now();
    const nextVersion = await commitRoomSnapshot(
      roomId,
      currentRoomState.version,
      mergeResult.shapes,
      {
        originNodeId: NODE_ID,
        senderId: userId,
        actionId,
        deletedShapeIds: parsed.deletedShapeIds,
        deletionMeta: parsed.deletionMeta,
      },
    );

    if (!nextVersion) {
      recordSnapshotCommitFailure();
      const roomState = await initializeRoomSync(roomId);
      const presenceState = getRoomPresenceState(roomId);

      ws.send(
        JSON.stringify({
          type: "sync_error",
          reason: `Version mismatch: server has ${roomState.version}`,
        } as ServerMessage),
      );

      ws.send(
        JSON.stringify({
          type: "room_joined",
          roomId,
          version: roomState.version,
          shapes: roomState.shapes,
          userId,
          connectedUsersCount: presenceState.connectedUsersCount,
          presences: presenceState.presences,
        } as ServerMessage),
      );
      return;
    }

    const commitLatencyMs = Math.max(0, Date.now() - commitStartedAtMs);
    const processLatencyMs = Math.max(0, Date.now() - snapshotStartedAtMs);
    recordSnapshotCommitted(commitLatencyMs, processLatencyMs);

    void enqueueRoomPersist(roomId, nextVersion, mergeResult.shapes);
    cacheRoomSyncState({
      roomId,
      version: nextVersion,
      shapes: mergeResult.shapes,
    });

    // Ack sender with new authoritative version only to avoid
    // expensive full-state hydrate on every local edit.
    ws.send(
      JSON.stringify({
        type: "canvas_snapshot_ack",
        roomId,
        version: nextVersion,
      } as ServerMessage),
    );

    const broadcastMsg: ServerMessage = {
      type: "canvas_snapshot_broadcast",
      roomId,
      version: nextVersion,
      shapes: mergeResult.shapes,
      senderId: userId,
      actionId,
      deletedShapeIds: parsed.deletedShapeIds,
      deletionMeta: parsed.deletionMeta,
    };

    broadcastToRoom(roomId, broadcastMsg, ws);

    // Durable queue publication is intentionally detached from the hot path.
    // Redis commit already finalized the authoritative room transition and
    // local clients have been acked/broadcasted. Keeping this async avoids
    // adding broker latency to live cursor/shape responsiveness.
    void publishDurableRoomEvent({
      type: "canvas_snapshot_broadcast",
      roomId,
      version: nextVersion,
      shapes: mergeResult.shapes,
      senderId: userId,
      originNodeId: NODE_ID,
      actionId,
      deletedShapeIds: parsed.deletedShapeIds,
      deletionMeta: parsed.deletionMeta,
      publishedAtMs: Date.now(),
    }).catch((error) => {
      // Redis Pub/Sub remains available as low-latency fan-out fallback.
      recordDurablePublishFailure();
      console.error("[WS] Failed to publish durable room event", {
        roomId,
        version: nextVersion,
        actionId,
        error,
      });
    });
    return;
  }

  if (parsed.type === "send_chat_message") {
    const { roomId, kind, body } = parsed;

    if (typeof roomId !== "number" || roomId <= 0) {
      ws.send(
        JSON.stringify({
          type: "sync_error",
          reason: "Invalid roomId",
        } as ServerMessage),
      );
      return;
    }

    if (ws.currentRoomId !== roomId) {
      ws.send(
        JSON.stringify({
          type: "sync_error",
          reason: "Forbidden",
        } as ServerMessage),
      );
      return;
    }

    if (!ws.userId) {
      return;
    }

    let recipientId: string | null = null;
    let shapeId: string | null = null;

    if (kind === "direct") {
      recipientId =
        typeof parsed.recipientUserId === "string"
          ? parsed.recipientUserId
          : null;

      if (!recipientId || recipientId === ws.userId) {
        ws.send(
          JSON.stringify({
            type: "sync_error",
            reason: "Invalid direct message recipient",
          } as ServerMessage),
        );
        return;
      }

      const recipientHasAccess = await hasRoomAccess(roomId, recipientId);
      if (!recipientHasAccess) {
        ws.send(
          JSON.stringify({
            type: "sync_error",
            reason: "Recipient is not allowed in this canvas",
          } as ServerMessage),
        );
        return;
      }
    }

    if (kind === "comment") {
      shapeId = typeof parsed.shapeId === "string" ? parsed.shapeId : null;

      if (!shapeId) {
        ws.send(
          JSON.stringify({
            type: "sync_error",
            reason: "Comments must target a shape",
          } as ServerMessage),
        );
        return;
      }

      const currentRoomState =
        roomSyncState.get(roomId) ?? (await initializeRoomSync(roomId));
      const shape = currentRoomState.shapes.find(
        (candidate) => candidate.id === shapeId,
      );

      if (!shape) {
        ws.send(
          JSON.stringify({
            type: "sync_error",
            reason: "Shape not found for comment",
          } as ServerMessage),
        );
        return;
      }
    }

    let createdChat;
    try {
      createdChat = await prismaClient.chat.create({
        data: {
          roomId,
          message: body,
          messageType:
            kind === "direct"
              ? "DIRECT"
              : kind === "comment"
                ? "COMMENT"
                : "GROUP",
          userId: ws.userId,
          recipientId,
          shapeId,
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              handle: true,
              photo: true,
            },
          },
          recipient: {
            select: {
              id: true,
              name: true,
              handle: true,
              photo: true,
            },
          },
        },
      });
    } catch (error: unknown) {
      const e = error as { code?: string };
      if (e?.code === "P2021" || e?.code === "P2022") {
        ws.send(
          JSON.stringify({
            type: "sync_error",
            reason:
              "Chat storage is not ready yet. Apply the latest database schema update.",
          } as ServerMessage),
        );
        return;
      }

      throw error;
    }

    const chatMessage: ServerMessage = {
      type: "chat_message_created",
      message: mapPersistedChatMessage(createdChat),
    };

    if (kind === "direct" && recipientId) {
      broadcastToRoomUsers(roomId, chatMessage, [ws.userId, recipientId]);

      void publishChatEvent(roomId, {
        type: "chat_message_created",
        kind,
        recipientIds: [ws.userId, recipientId],
        message: mapPersistedChatMessage(createdChat),
      }).catch((err) =>
        console.error("[WS] Failed to publish chat event", err),
      );
      return;
    }

    broadcastToRoomAll(roomId, chatMessage);

    void publishChatEvent(roomId, {
      type: "chat_message_created",
      kind,
      recipientIds: null,
      message: mapPersistedChatMessage(createdChat),
    }).catch((err) => console.error("[WS] Failed to publish chat event", err));
    return;
  }
}
