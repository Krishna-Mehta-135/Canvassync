/**
 * WebSocket Protocol
 *
 * Defines all message types exchanged between client and WS server.
 * Version tracking prevents overwrite collisions and enables explicit resync.
 */

import type { Shape } from "@repo/canvas-engine";
import { z } from "zod";

const CanvasShapeSchema = z
  .object({
    id: z.string().min(1).max(200),
    type: z.string().min(1).max(64),
  })
  .passthrough();

const ChatParticipantSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  handle: z.string().min(1).max(200).nullable(),
  photo: z.string().min(1).max(2048).nullable().optional(),
});

const ChatMessageKindSchema = z.enum(["group", "direct", "comment"]);

const PersistedChatMessageSchema = z.object({
  id: z.number().int().positive(),
  roomId: z.number().int().positive(),
  kind: ChatMessageKindSchema,
  body: z.string().min(1).max(4000),
  shapeId: z.string().min(1).max(200).nullable(),
  createdAt: z.string().min(1).max(64),
  sender: ChatParticipantSchema,
  recipient: ChatParticipantSchema.nullable(),
});

const ActionIdSchema = z.string().min(8).max(128);

const CanvasCrdtMetadataSchema = z.object({
  clock: z.number().int().nonnegative(),
  clientId: z.string().min(1).max(200),
});

/**
 * Cursor position shared between collaborators for presence rendering.
 */
export type PresenceCursor = {
  x: number;
  y: number;
};

/**
 * Presence snapshot for one user in a room.
 */
export type RoomPresence = {
  userId: string;
  userName: string;
  cursor: PresenceCursor | null;
  selectedIds: string[];
  tool: string | null;
};

/**
 * Full room-level presence state sent by the websocket server.
 */
export type RoomPresenceState = {
  roomId: number;
  connectedUsersCount: number;
  presences: RoomPresence[];
};

/**
 * Broadcast payload used when the server refreshes room presence.
 */
export type RoomPresenceMessage = RoomPresenceState & {
  type: "room_presence_state";
};

/**
 * Short-lived, never-persisted presence events (live cursor, cursor chat,
 * emoji reactions, viewport for follow mode). Coordinates are canvas-space.
 */
export type EphemeralEvent =
  | { kind: "cursor"; x: number; y: number }
  | { kind: "cursor_chat"; text: string | null }
  | { kind: "reaction"; emoji: string; x: number; y: number }
  // x/y are the canvas-space point at the centre of the sender's screen, so
  // followers with different screen sizes land on the same content.
  // `present` marks the sender as presenting: everyone auto-follows them.
  | {
      kind: "viewport";
      x: number;
      y: number;
      scale: number;
      present?: boolean;
    };

/** What the connected user may do in a room. VIEWERs cannot change the canvas. */
export type RoomRole = "OWNER" | "EDITOR" | "VIEWER";

export type WsMessage =
  | { type: "join_room"; roomId: number }
  | {
      type: "room_joined";
      roomId: number;
      role?: RoomRole;
      version: number;
      shapes: Shape[];
      userId: string;
      connectedUsersCount: number;
      presences: RoomPresence[];
    }
  | {
      type: "canvas_snapshot";
      roomId: number;
      version: number;
      shapes: Shape[];
      deletedShapeIds?: string[];
      deletionMeta?: {
        clock: number;
        clientId: string;
      } | null;
    }
  | {
      type: "canvas_snapshot_broadcast";
      roomId: number;
      version: number;
      shapes: Shape[];
      senderId: string;
      actionId?: string;
      deletedShapeIds?: string[];
      deletionMeta?: {
        clock: number;
        clientId: string;
      } | null;
    }
  | {
      type: "canvas_snapshot_ack";
      roomId: number;
      version: number;
    }
  | {
      type: "update_presence";
      roomId: number;
      cursor: PresenceCursor | null;
      selectedIds: string[];
      tool: string | null;
    }
  | {
      type: "ephemeral";
      roomId: number;
      event: EphemeralEvent;
    }
  | {
      type: "ephemeral_broadcast";
      roomId: number;
      senderId: string;
      senderName: string;
      event: EphemeralEvent;
    }
  | {
      type: "send_chat_message";
      roomId: number;
      kind: "group" | "direct" | "comment";
      body: string;
      recipientUserId?: string;
      shapeId?: string;
    }
  | {
      type: "chat_message_created";
      message: {
        id: number;
        roomId: number;
        kind: "group" | "direct" | "comment";
        body: string;
        shapeId: string | null;
        createdAt: string;
        sender: {
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
      };
    }
  | RoomPresenceMessage
  | { type: "sync_error"; reason: string }
  | { type: "pong" };

// Server -> Client announcements
export type ServerMessage =
  | {
      type: "room_joined";
      roomId: number;
      role?: RoomRole;
      version: number;
      shapes: Shape[];
      userId: string;
      connectedUsersCount: number;
      presences: RoomPresence[];
    }
  | {
      type: "canvas_snapshot_broadcast";
      roomId: number;
      version: number;
      shapes: Shape[];
      senderId: string;
      actionId?: string;
      deletedShapeIds?: string[];
      deletionMeta?: {
        clock: number;
        clientId: string;
      } | null;
    }
  | {
      type: "canvas_snapshot_ack";
      roomId: number;
      version: number;
    }
  | {
      type: "chat_message_created";
      message: {
        id: number;
        roomId: number;
        kind: "group" | "direct" | "comment";
        body: string;
        shapeId: string | null;
        createdAt: string;
        sender: {
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
      };
    }
  | RoomPresenceMessage
  | {
      type: "ephemeral_broadcast";
      roomId: number;
      senderId: string;
      senderName: string;
      event: EphemeralEvent;
    }
  | { type: "sync_error"; reason: string }
  | { type: "pong" };

// Client -> Server commands
export type ClientMessage = Extract<
  WsMessage,
  {
    type:
      | "join_room"
      | "canvas_snapshot"
      | "update_presence"
      | "ephemeral"
      | "send_chat_message";
  }
>;

export const PresenceCursorSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const JoinRoomMessageSchema = z.object({
  type: z.literal("join_room"),
  roomId: z.number().int().positive(),
});

export const CanvasSnapshotMessageSchema = z.object({
  type: z.literal("canvas_snapshot"),
  roomId: z.number().int().positive(),
  version: z.number().int().min(0),
  shapes: z.array(CanvasShapeSchema).max(5000),
  deletedShapeIds: z.array(z.string().min(1).max(200)).max(5000).optional(),
  deletionMeta: CanvasCrdtMetadataSchema.nullable().optional(),
});

export const UpdatePresenceMessageSchema = z.object({
  type: z.literal("update_presence"),
  roomId: z.number().int().positive(),
  cursor: PresenceCursorSchema.nullable(),
  selectedIds: z.array(z.string().min(1).max(200)).max(1000),
  tool: z.string().min(1).max(64).nullable(),
});

export const EphemeralEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cursor"),
    x: z.number().finite(),
    y: z.number().finite(),
  }),
  z.object({
    kind: z.literal("cursor_chat"),
    text: z.string().trim().max(140).nullable(),
  }),
  z.object({
    kind: z.literal("reaction"),
    emoji: z.string().min(1).max(16),
    x: z.number().finite(),
    y: z.number().finite(),
  }),
  z.object({
    kind: z.literal("viewport"),
    x: z.number().finite(),
    y: z.number().finite(),
    scale: z.number().finite().positive(),
    present: z.boolean().optional(),
  }),
]);

export const EphemeralMessageSchema = z.object({
  type: z.literal("ephemeral"),
  roomId: z.number().int().positive(),
  event: EphemeralEventSchema,
});

export const SendChatMessageSchema = z
  .object({
    type: z.literal("send_chat_message"),
    roomId: z.number().int().positive(),
    kind: ChatMessageKindSchema,
    body: z.string().trim().min(1).max(2000),
    recipientUserId: z.string().min(1).max(200).optional(),
    shapeId: z.string().min(1).max(200).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "direct" && !value.recipientUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recipientUserId"],
        message: "recipientUserId is required for direct messages",
      });
    }

    if (value.kind === "comment" && !value.shapeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["shapeId"],
        message: "shapeId is required for comments",
      });
    }
  });

export const ClientWsMessageSchema = z.discriminatedUnion("type", [
  JoinRoomMessageSchema,
  CanvasSnapshotMessageSchema,
  UpdatePresenceMessageSchema,
  EphemeralMessageSchema,
  SendChatMessageSchema,
]);

export type ClientWsMessage = z.infer<typeof ClientWsMessageSchema>;

export const ChatMessageCreatedSchema = z.object({
  type: z.literal("chat_message_created"),
  message: PersistedChatMessageSchema,
});

/**
 * Per-room sync state tracked by server.
 * Version increments on each accepted snapshot.
 */
export interface RoomSyncState {
  roomId: number;
  version: number;
  shapes: Shape[];
}

/**
 * Canonical server-to-server snapshot event used by Redis Pub/Sub and
 * durable queue transport.
 */
export type RoomSnapshotBroadcastEvent = {
  type: "canvas_snapshot_broadcast";
  roomId: number;
  version: number;
  shapes: Shape[];
  senderId?: string;
  deletedShapeIds?: string[];
  deletionMeta?: {
    clock: number;
    clientId: string;
  } | null;
  originNodeId: string;
  actionId: string;
  publishedAtMs: number;
};

export const RoomSnapshotBroadcastEventSchema = z.object({
  type: z.literal("canvas_snapshot_broadcast"),
  roomId: z.number().int().positive(),
  version: z.number().int().min(1),
  shapes: z.array(CanvasShapeSchema).max(5000),
  senderId: z.string().min(1).max(200).optional(),
  deletedShapeIds: z.array(z.string().min(1).max(200)).max(5000).optional(),
  deletionMeta: CanvasCrdtMetadataSchema.nullable().optional(),
  originNodeId: z.string().min(1).max(200),
  actionId: ActionIdSchema,
  publishedAtMs: z.number().int().nonnegative(),
});
