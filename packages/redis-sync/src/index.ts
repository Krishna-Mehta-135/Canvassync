import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import type { Shape } from "@repo/canvas-engine";
import type {
  RoomSyncState,
  RoomPresence,
  PersistedChatMessage,
  EphemeralEvent,
} from "@repo/common";
import { RoomSnapshotBroadcastEventSchema } from "@repo/common/ws-protocol";
import { REDIS_URL } from "@repo/backend-common/config";

export const NODE_ID = randomUUID();

// Redis is the shared authority for room sync state across all WS processes.
// We keep the protocol contract unchanged and only use Redis internally for
// versioning, snapshot storage, and cross-node fan-out.
//
// NOTE: All key-based commands automatically receive the "canvas:" prefix via
// the ioredis `keyPrefix` option below. This isolates Canvas data from any
// other application (e.g. Knowdex) sharing the same Memorystore instance.
// IMPORTANT: ioredis does NOT apply keyPrefix to Pub/Sub channel names, so
// channels are still prefixed manually via ROOM_CHANNEL_PREFIX.
const ROOM_CHANNEL_PREFIX = "canvas:room"; // Used for Pub/Sub — must stay explicit
const PRESENCE_CHANNEL_PREFIX = "canvas:presence"; // Used for Pub/Sub — must stay explicit
const CHAT_CHANNEL_PREFIX = "canvas:chat"; // Used for Pub/Sub — must stay explicit
const ROOM_VERSION_PREFIX = "room:version"; // Key prefix applied by ioredis → canvas:room:version:*
const ROOM_SNAPSHOT_PREFIX = "room:snapshot"; // Key prefix applied by ioredis → canvas:room:snapshot:*

const redisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: true,
  // Isolates all Canvas key-space from other apps sharing the same Redis/Memorystore.
  // Applied automatically to GET, SET, INCR, WATCH, MULTI, EVAL, etc.
  keyPrefix: "canvas:",
};

const publisher = new Redis(REDIS_URL, redisOptions);
const subscriber = new Redis(REDIS_URL, redisOptions);

// Namespace for HTTP rate-limit keys (separate from room-sync keys).
// ioredis prepends "canvas:" → final key: canvas:http:rate-limit:*
const RATE_LIMIT_KEY_PREFIX = "http:rate-limit";

export type RedisRateLimitResult = {
  allowed: boolean;
  current: number;
  limit: number;
  remaining: number;
  resetAtMs: number;
  retryAfterMs: number;
};

export type RedisRoomEvent = {
  roomId: number;
  originNodeId: string;
  version: number;
  shapes: Shape[];
  senderId?: string;
  deletedShapeIds?: string[];
  deletionMeta?: {
    clock: number;
    clientId: string;
  } | null;
  actionId: string;
  publishedAtMs: number;
  type: "canvas_snapshot_broadcast";
};

export type RedisPresenceEvent = {
  type: "room_presence_state";
  roomId: number;
  originNodeId: string;
  connectedUsersCount: number;
  presences: RoomPresence[];
};

export type RedisEphemeralEvent = {
  type: "ephemeral_broadcast";
  roomId: number;
  originNodeId: string;
  senderId: string;
  senderName: string;
  event: EphemeralEvent;
};

export type RedisChatEvent = {
  type: "chat_message_created";
  roomId: number;
  originNodeId: string;
  kind: "group" | "direct" | "comment";
  recipientIds: string[] | null; // null = group broadcast
  message: PersistedChatMessage;
};

function roomVersionKey(roomId: number) {
  return `${ROOM_VERSION_PREFIX}:${roomId}`;
}

function roomSnapshotKey(roomId: number) {
  return `${ROOM_SNAPSHOT_PREFIX}:${roomId}`;
}

function roomChannel(roomId: number) {
  return `${ROOM_CHANNEL_PREFIX}:${roomId}`;
}

function presenceChannel(roomId: number) {
  return `${PRESENCE_CHANNEL_PREFIX}:${roomId}`;
}

function chatChannel(roomId: number) {
  return `${CHAT_CHANNEL_PREFIX}:${roomId}`;
}

function rateLimitKey(routeKey: string) {
  return `${RATE_LIMIT_KEY_PREFIX}:${routeKey}`;
}

/**
 * Ensures publisher/subscriber clients are connected before use.
 *
 * Clients are configured with `lazyConnect`, so operations must explicitly
 * connect when status indicates a disconnected/waiting state.
 */
async function ensureReady() {
  if (publisher.status === "wait" || publisher.status === "end") {
    await publisher.connect();
  }

  if (subscriber.status === "wait" || subscriber.status === "end") {
    await subscriber.connect();
  }
}

export async function getRoomVersion(roomId: number) {
  await ensureReady();

  const rawVersion = await publisher.get(roomVersionKey(roomId));
  return Number(rawVersion ?? 0);
}

export async function bumpRoomVersion(roomId: number) {
  await ensureReady();
  return publisher.incr(roomVersionKey(roomId));
}

export async function getRoomSnapshot(
  roomId: number,
): Promise<RoomSyncState | null> {
  await ensureReady();

  const [rawVersion, rawSnapshot] = await Promise.all([
    publisher.get(roomVersionKey(roomId)),
    publisher.get(roomSnapshotKey(roomId)),
  ]);

  if (!rawSnapshot) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawSnapshot) as {
      roomId: number;
      version: number;
      shapes: Shape[];
    };
    return {
      roomId,
      version: Number(rawVersion ?? parsed.version ?? 0),
      shapes: Array.isArray(parsed.shapes) ? parsed.shapes : [],
    };
  } catch {
    return null;
  }
}

export async function setRoomSnapshot(
  roomId: number,
  snapshot: Shape[],
  version: number,
) {
  await ensureReady();

  const multi = publisher.multi();
  multi.set(roomVersionKey(roomId), String(version));
  multi.set(
    roomSnapshotKey(roomId),
    JSON.stringify({ roomId, version, shapes: snapshot }),
  );
  await multi.exec();
}

export async function publishRoomEvent(
  roomId: number,
  event: Omit<RedisRoomEvent, "roomId">,
) {
  await ensureReady();

  const payload: RedisRoomEvent = {
    roomId,
    ...event,
  };

  await publisher.publish(roomChannel(roomId), JSON.stringify(payload));
}

export async function publishPresenceEvent(
  roomId: number,
  event: Omit<RedisPresenceEvent, "roomId" | "originNodeId">,
) {
  await ensureReady();

  const payload: RedisPresenceEvent = {
    roomId,
    originNodeId: NODE_ID,
    ...event,
  };

  await publisher.publish(presenceChannel(roomId), JSON.stringify(payload));
}

// Ephemeral events (cursors, reactions, viewport) share the presence channel;
// subscribers distinguish them by `type`.
export async function publishEphemeralEvent(
  roomId: number,
  event: Omit<RedisEphemeralEvent, "roomId" | "originNodeId" | "type">,
) {
  await ensureReady();

  const payload: RedisEphemeralEvent = {
    type: "ephemeral_broadcast",
    roomId,
    originNodeId: NODE_ID,
    ...event,
  };

  await publisher.publish(presenceChannel(roomId), JSON.stringify(payload));
}

export async function publishChatEvent(
  roomId: number,
  event: Omit<RedisChatEvent, "roomId" | "originNodeId">,
) {
  await ensureReady();

  const payload: RedisChatEvent = {
    roomId,
    originNodeId: NODE_ID,
    ...event,
  };

  await publisher.publish(chatChannel(roomId), JSON.stringify(payload));
}

// Snapshot commits are atomic at the Redis level: version increment, snapshot
// replacement, and Pub/Sub fan-out all happen together so every node observes
// the same authoritative room transition.
export async function commitRoomSnapshot(
  roomId: number,
  expectedVersion: number,
  snapshot: Shape[],
  event: Pick<
    RedisRoomEvent,
    | "originNodeId"
    | "senderId"
    | "actionId"
    | "deletedShapeIds"
    | "deletionMeta"
  >,
) {
  await ensureReady();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    // WATCH keeps the write safe if another node wins the version race.
    await publisher.watch(roomVersionKey(roomId));
    const currentVersion = Number(
      (await publisher.get(roomVersionKey(roomId))) ?? 0,
    );

    if (currentVersion !== expectedVersion) {
      await publisher.unwatch();
      return null;
    }

    const nextVersion = currentVersion + 1;
    const payload: RedisRoomEvent = {
      roomId,
      originNodeId: event.originNodeId,
      senderId: event.senderId,
      deletedShapeIds: event.deletedShapeIds,
      deletionMeta: event.deletionMeta,
      actionId: event.actionId,
      publishedAtMs: Date.now(),
      type: "canvas_snapshot_broadcast",
      version: nextVersion,
      shapes: snapshot,
    };

    const transaction = publisher.multi();
    transaction.incr(roomVersionKey(roomId));
    transaction.set(
      roomSnapshotKey(roomId),
      JSON.stringify({ roomId, version: nextVersion, shapes: snapshot }),
    );
    transaction.publish(roomChannel(roomId), JSON.stringify(payload));

    const result = await transaction.exec();
    if (result) {
      return nextVersion;
    }
  }

  return null;
}

export async function subscribeRoomEvents(
  handler: (event: RedisRoomEvent) => void | Promise<void>,
) {
  await ensureReady();

  // Every WS node subscribes to every room topic and filters by roomId in the
  // payload. That keeps the wiring simple and avoids per-room subscription
  // churn when rooms are created or destroyed.
  await subscriber.psubscribe(`${ROOM_CHANNEL_PREFIX}:*`);
  subscriber.on(
    "pmessage",
    async (_pattern: string, channel: string, message: string) => {
      try {
        if (!channel.startsWith(`${ROOM_CHANNEL_PREFIX}:`)) {
          return;
        }

        const event = JSON.parse(message) as RedisRoomEvent;
        const parsedEvent = RoomSnapshotBroadcastEventSchema.safeParse(event);
        if (!parsedEvent.success) {
          return;
        }

        const normalizedEvent = {
          ...parsedEvent.data,
          shapes: parsedEvent.data.shapes as Shape[],
        } as RedisRoomEvent;

        await handler(normalizedEvent);
      } catch (error) {
        console.error("[WS][Redis] Failed to process room event", {
          channel,
          error,
        });
      }
    },
  );
}

export async function subscribePresenceEvents(
  handler: (
    event: RedisPresenceEvent | RedisEphemeralEvent,
  ) => void | Promise<void>,
) {
  await ensureReady();

  await subscriber.psubscribe(`${PRESENCE_CHANNEL_PREFIX}:*`);
  subscriber.on(
    "pmessage",
    async (_pattern: string, channel: string, message: string) => {
      try {
        if (!channel.startsWith(`${PRESENCE_CHANNEL_PREFIX}:`)) {
          return;
        }

        const event = JSON.parse(message) as
          | RedisPresenceEvent
          | RedisEphemeralEvent;

        if (event.originNodeId === NODE_ID) {
          return;
        }

        await handler(event);
      } catch (error) {
        console.error("[WS][Redis] Failed to process presence event", {
          channel,
          error,
        });
      }
    },
  );
}

export async function subscribeChatEvents(
  handler: (event: RedisChatEvent) => void | Promise<void>,
) {
  await ensureReady();

  await subscriber.psubscribe(`${CHAT_CHANNEL_PREFIX}:*`);
  subscriber.on(
    "pmessage",
    async (_pattern: string, channel: string, message: string) => {
      try {
        if (!channel.startsWith(`${CHAT_CHANNEL_PREFIX}:`)) {
          return;
        }

        const event = JSON.parse(message) as RedisChatEvent;

        if (event.originNodeId === NODE_ID) {
          return;
        }

        await handler(event);
      } catch (error) {
        console.error("[WS][Redis] Failed to process chat event", {
          channel,
          error,
        });
      }
    },
  );
}

export async function checkRedisRateLimit(
  routeKey: string,
  limit: number,
  windowMs: number,
): Promise<RedisRateLimitResult> {
  await ensureReady();

  // Clamp values defensively to avoid invalid/negative limiter settings.
  const safeLimit = Math.max(1, Math.floor(limit));
  const safeWindowMs = Math.max(1, Math.floor(windowMs));
  const key = rateLimitKey(routeKey);
  const now = Date.now();

  // Lua script keeps INCR + initial TTL assignment atomic.
  // Without this, concurrent requests could observe race conditions where
  // counters increment without a matching expiration.
  const script = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
if ttl < 0 then
  ttl = tonumber(ARGV[1])
end
return {current, ttl}
`;

  // eval result returns [currentCount, ttlMs].
  const result = (await publisher.eval(
    script,
    1,
    key,
    String(safeWindowMs),
  )) as [number, number] | null;
  const current = Array.isArray(result) ? Number(result[0] ?? 0) : 0;
  const ttlMs = Array.isArray(result)
    ? Number(result[1] ?? safeWindowMs)
    : safeWindowMs;
  const resetAtMs = now + Math.max(0, ttlMs);
  const allowed = current <= safeLimit;

  return {
    allowed,
    current,
    limit: safeLimit,
    // Remaining is never negative to keep headers/client logic simple.
    remaining: Math.max(0, safeLimit - current),
    resetAtMs,
    // Retry hint is only meaningful when request is blocked.
    retryAfterMs: allowed ? 0 : Math.max(0, ttlMs),
  };
}

/**
 * Shared Redis client for use across the monorepo (e.g. HTTP backend).
 *
 * NOTE: This client includes the "canvas:" keyPrefix.
 */
export const sharedRedisClient = publisher;
