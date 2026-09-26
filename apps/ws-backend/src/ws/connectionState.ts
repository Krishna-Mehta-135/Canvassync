import { WebSocket } from "ws";
import type {
  RoomPresence,
  RoomPresenceState,
  ServerMessage,
} from "@repo/common";
import { publishPresenceEvent } from "@repo/redis-sync";
import type { AuthenticatedWebSocket } from "./types.js";

/**
 * userSockets
 *
 * Maps each connected userId to their WebSocket connections.
 * Map structure:
 * userId -> Set<WebSocket>
 */
export const userSockets = new Map<string, Set<AuthenticatedWebSocket>>();

/**
 * activeRooms
 *
 * Runtime in-memory structure that tracks which sockets
 * are currently subscribed to which rooms via WebSockets.
 *
 * Map structure:
 * roomId -> Set of sockets currently connected
 */
export const activeRooms = new Map<number, Set<AuthenticatedWebSocket>>();
const roomParticipants = new Map<number, Map<string, number>>();
const roomPresences = new Map<number, Map<string, RoomPresence>>();

// Active shared countdown per room (in memory; every node stores the timers it
// sees, including ones relayed from other nodes, so late joiners get them).
type RoomTimer = { endsAt: number; label?: string; senderId: string; senderName: string };
const roomTimers = new Map<number, RoomTimer>();

export function setRoomTimer(roomId: number, timer: RoomTimer | null) {
  if (timer && timer.endsAt > Date.now()) roomTimers.set(roomId, timer);
  else roomTimers.delete(roomId);
}

/** The still-running timer for a room, if any (expired ones are dropped). */
export function getRoomTimer(roomId: number): RoomTimer | null {
  const timer = roomTimers.get(roomId);
  if (!timer) return null;
  if (timer.endsAt <= Date.now()) {
    roomTimers.delete(roomId);
    return null;
  }
  return timer;
}

const pendingPresenceBroadcast = new Map<
  number,
  ReturnType<typeof setTimeout>
>();
const PRESENCE_BROADCAST_DEBOUNCE_MS = 50;

/**
 * Registers a user socket so connection and room state can be updated later.
 */
export function registerUser(userId: string, ws: AuthenticatedWebSocket) {
  ws.userId = userId;

  if (!userSockets.has(userId)) {
    userSockets.set(userId, new Set());
  }

  userSockets.get(userId)?.add(ws);
}

/**
 * Removes one socket from the user index when it disconnects.
 */
export function removeUserSocket(ws: AuthenticatedWebSocket) {
  if (!ws.userId) return;

  const sockets = userSockets.get(ws.userId);
  if (!sockets) return;

  sockets.delete(ws);
  if (sockets.size === 0) {
    userSockets.delete(ws.userId);
  }
}

/**
 * Marks a socket as connected to a room and tracks the room's user count.
 */
export function joinActiveRoom(roomId: number, ws: AuthenticatedWebSocket) {
  if (!activeRooms.has(roomId)) {
    activeRooms.set(roomId, new Set());
  }

  activeRooms.get(roomId)?.add(ws);
  ws.currentRoomId = roomId;

  if (!ws.userId) {
    return false;
  }

  if (!roomParticipants.has(roomId)) {
    roomParticipants.set(roomId, new Map());
  }

  const participants = roomParticipants.get(roomId)!;
  const currentCount = participants.get(ws.userId) ?? 0;
  participants.set(ws.userId, currentCount + 1);

  return currentCount === 0;
}

/**
 * Removes a socket from a room and returns true when the user leaves entirely.
 */
export function leaveActiveRoom(roomId: number, ws: AuthenticatedWebSocket) {
  const roomSockets = activeRooms.get(roomId);
  if (!roomSockets) return false;

  roomSockets.delete(ws);
  if (roomSockets.size === 0) {
    activeRooms.delete(roomId);
  }

  if (!ws.userId) {
    return false;
  }

  const participants = roomParticipants.get(roomId);
  if (!participants) {
    return false;
  }

  const currentCount = participants.get(ws.userId) ?? 0;
  if (currentCount <= 1) {
    participants.delete(ws.userId);
    if (participants.size === 0) {
      roomParticipants.delete(roomId);
    }
    return true;
  }

  participants.set(ws.userId, currentCount - 1);
  return false;
}

/**
 * Broadcasts a message to the other sockets in the room.
 */
export function broadcastToRoom(
  roomId: number,
  message: ServerMessage,
  senderWs: AuthenticatedWebSocket,
) {
  const roomSockets = activeRooms.get(roomId);
  if (!roomSockets) return;

  // Serialize once to reduce CPU/GC pressure when fan-out targets many peers.
  const serializedMessage = JSON.stringify(message);

  for (const socket of roomSockets) {
    if (socket === senderWs) continue;

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(serializedMessage);
    }
  }
}

/**
 * Broadcasts a message to every socket currently connected to the room.
 */
export function broadcastToRoomAll(roomId: number, message: ServerMessage) {
  const roomSockets = activeRooms.get(roomId);
  if (!roomSockets) return;

  const serializedMessage = JSON.stringify(message);

  for (const socket of roomSockets) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(serializedMessage);
    }
  }
}

/**
 * Broadcasts a message to a subset of users currently connected to the room.
 */
export function broadcastToRoomUsers(
  roomId: number,
  message: ServerMessage,
  userIds: string[],
) {
  const roomSockets = activeRooms.get(roomId);
  if (!roomSockets) return;

  const allowedUserIds = new Set(userIds);
  const serializedMessage = JSON.stringify(message);

  for (const socket of roomSockets) {
    if (!socket.userId || !allowedUserIds.has(socket.userId)) {
      continue;
    }

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(serializedMessage);
    }
  }
}

/**
 * Stores the latest cursor and selection snapshot for one room participant.
 */
export function setRoomPresence(
  roomId: number,
  userId: string,
  presence: RoomPresence,
) {
  if (!roomPresences.has(roomId)) {
    roomPresences.set(roomId, new Map());
  }

  roomPresences.get(roomId)?.set(userId, {
    ...presence,
    tool: presence.tool ?? null,
  });
}

/**
 * Deletes the cached presence snapshot for a participant.
 */
export function removeRoomPresence(roomId: number, userId: string) {
  const presences = roomPresences.get(roomId);
  if (!presences) return;

  presences.delete(userId);
  if (presences.size === 0) {
    roomPresences.delete(roomId);
  }
}

/**
 * Returns the current presence snapshot for a room.
 */
export function getRoomPresenceState(roomId: number): RoomPresenceState {
  const presences = roomPresences.get(roomId);
  return {
    roomId,
    connectedUsersCount: roomParticipants.get(roomId)?.size ?? 0,
    presences: presences ? [...presences.values()] : [],
  };
}

/**
 * Emits the latest room presence snapshot to all connected clients.
 */
export function broadcastRoomPresenceState(roomId: number) {
  const existing = pendingPresenceBroadcast.get(roomId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingPresenceBroadcast.delete(roomId);
    const state = getRoomPresenceState(roomId);

    // local broadcast (unchanged)
    broadcastToRoomAll(roomId, {
      type: "room_presence_state",
      ...state,
    });

    // cross-node publish (new)
    publishPresenceEvent(roomId, {
      type: "room_presence_state",
      connectedUsersCount: state.connectedUsersCount,
      presences: state.presences,
    }).catch((err) =>
      console.error("[WS] Failed to publish presence event", err),
    );
  }, PRESENCE_BROADCAST_DEBOUNCE_MS);

  pendingPresenceBroadcast.set(roomId, timer);
}

/**
 * Merges remote presences into local state and broadcasts to local sockets.
 */
export function applyRemotePresenceState(
  roomId: number,
  presences: RoomPresence[],
  connectedUsersCount: number,
) {
  // Merge remote presences into local roomPresences map.
  for (const presence of presences) {
    setRoomPresence(roomId, presence.userId, presence);
  }

  const localCount = roomParticipants.get(roomId)?.size ?? 0;
  const totalCount = localCount + connectedUsersCount;
  const mergedPresences = roomPresences.get(roomId);

  broadcastToRoomAll(roomId, {
    type: "room_presence_state",
    roomId,
    connectedUsersCount: totalCount,
    presences: mergedPresences ? [...mergedPresences.values()] : [],
  });
}
