import { randomUUID } from "node:crypto";
import { prismaClient } from "@repo/db/client";
import type { Shape } from "@repo/canvas-engine";
import type { CanvasCrdtMetadata, RoomSyncState } from "@repo/common";
import { publishRoomPersistJob } from "@repo/queue-sync";
import {
  getRoomSnapshot,
  getRoomVersion,
  setRoomSnapshot,
} from "@repo/redis-sync";

/**
 * roomSyncState
 *
 * Per-room sync state: version number and current shapes.
 * Version increments on each accepted snapshot from clients.
 */
export const roomSyncState = new Map<number, RoomSyncState>();
export const roomCrdtTombstones = new Map<
  number,
  Map<string, CanvasCrdtMetadata>
>();
const pendingPersistTimer = new Map<number, ReturnType<typeof setTimeout>>();
const pendingPersistShapes = new Map<number, Shape[]>();
const persistInFlight = new Set<number>();
let durablePersistFailureCount = 0;
let durablePersistRetryAfterMs = 0;

function getDurablePersistCooldownMs(failureCount: number) {
  const initialDelayMs = 2000;
  const maxDelayMs = 30000;
  const exponentialDelay =
    initialDelayMs * Math.pow(2, Math.max(0, failureCount - 1));
  return Math.min(maxDelayMs, exponentialDelay);
}

// This cache is intentionally non-authoritative. Redis decides the current room
// version; the cache only avoids repeated snapshot deserialization on the hot path.
export function cacheRoomSyncState(state: RoomSyncState) {
  roomSyncState.set(state.roomId, state);
}

export async function initializeRoomSync(roomId: number) {
  // Redis wins first. If it has the latest snapshot, we reuse it directly.
  const redisState = await getRoomSnapshot(roomId);
  if (redisState) {
    cacheRoomSyncState(redisState);
    return redisState;
  }

  // If Redis has the version but no snapshot blob, preserve version continuity
  // and rebuild the snapshot from Postgres.
  const currentVersion = await getRoomVersion(roomId);

  const shapes = await prismaClient.shape.findMany({
    where: {
      roomId,
      deleted: false,
    },
    orderBy: {
      createdAt: "asc",
    },
  });

  const state: RoomSyncState = {
    roomId,
    version: currentVersion,
    shapes: shapes.map((shape) => shape.props as Shape),
  };

  cacheRoomSyncState(state);
  await setRoomSnapshot(roomId, state.shapes, state.version);
  return state;
}

// ── Version history ──────────────────────────────────────────────────────────
// Every persisted canvas state is a candidate for a history snapshot, but we
// only record one per room per interval (trailing edge, so the final state of an
// editing burst is always captured) and skip states identical to the last one.
const HISTORY_MIN_INTERVAL_MS = Number(
  process.env.HISTORY_MIN_INTERVAL_MS ?? 30_000,
);
const HISTORY_MAX_SNAPSHOTS_PER_ROOM = Number(
  process.env.HISTORY_MAX_SNAPSHOTS_PER_ROOM ?? 60,
);
const historyPendingShapes = new Map<number, Shape[]>();
const historyTimers = new Map<number, ReturnType<typeof setTimeout>>();
const historyLastFingerprint = new Map<number, string>();

async function writeHistorySnapshot(roomId: number) {
  const shapes = historyPendingShapes.get(roomId);
  historyPendingShapes.delete(roomId);
  if (!shapes) return;

  const fingerprint = JSON.stringify(shapes);
  if (historyLastFingerprint.get(roomId) === fingerprint) return;

  try {
    await prismaClient.roomSnapshot.create({
      data: {
        roomId,
        shapes: shapes as unknown as object,
        shapeCount: shapes.length,
      },
    });
    historyLastFingerprint.set(roomId, fingerprint);

    const stale = await prismaClient.roomSnapshot.findMany({
      where: { roomId },
      orderBy: { createdAt: "desc" },
      skip: HISTORY_MAX_SNAPSHOTS_PER_ROOM,
      select: { id: true },
    });
    if (stale.length > 0) {
      await prismaClient.roomSnapshot.deleteMany({
        where: { id: { in: stale.map((row) => row.id) } },
      });
    }
  } catch (error) {
    // History is best-effort and must never affect live sync/persistence.
    console.error(`[WS] Failed to record history for room ${roomId}`, error);
  }
}

function scheduleHistorySnapshot(roomId: number, shapes: Shape[]) {
  historyPendingShapes.set(roomId, shapes);
  if (historyTimers.has(roomId)) return;

  const timer = setTimeout(() => {
    historyTimers.delete(roomId);
    void writeHistorySnapshot(roomId);
  }, HISTORY_MIN_INTERVAL_MS);
  timer.unref();
  historyTimers.set(roomId, timer);
}

export async function persistShapes(roomId: number, shapes: Shape[]) {
  // Validate all shapes have required fields
  for (const shape of shapes) {
    if (!shape.id || typeof shape.id !== "string") {
      throw new Error("All shapes must have a valid string id");
    }
    if (!shape.type || typeof shape.type !== "string") {
      throw new Error("All shapes must have a valid string type");
    }
  }

  // Deduplicate shapes by ID (keep last occurrence)
  const uniqueShapesMap = new Map<string, Shape>();
  for (const shape of shapes) {
    uniqueShapesMap.set(shape.id, shape);
  }
  const uniqueShapes = Array.from(uniqueShapesMap.values());

  await prismaClient.$transaction(async (tx) => {
    await tx.shape.deleteMany({
      where: {
        roomId,
      },
    });

    if (uniqueShapes.length > 0) {
      await tx.shape.createMany({
        data: uniqueShapes.map((shape) => ({
          // Database id must be globally unique across all rooms.
          // Keep client shape.id inside props unchanged for canvas logic.
          id: `${roomId}:${shape.id}`,
          roomId,
          type: shape.type,
          props: shape,
          deleted: false,
        })),
        skipDuplicates: true,
      });
    }
  });

  scheduleHistorySnapshot(roomId, uniqueShapes);
}

async function persistQueuedRoom(roomId: number) {
  if (persistInFlight.has(roomId)) {
    return;
  }

  const shapes = pendingPersistShapes.get(roomId);
  if (!shapes) {
    return;
  }

  pendingPersistShapes.delete(roomId);
  persistInFlight.add(roomId);

  try {
    await persistShapes(roomId, shapes);
  } catch (error) {
    console.error(`[WS] Failed to persist room ${roomId} snapshot`, error);
  } finally {
    persistInFlight.delete(roomId);
    if (pendingPersistShapes.has(roomId)) {
      void persistQueuedRoom(roomId);
    }
  }
}

/**
 * Queue room persistence without blocking realtime sync path.
 *
 * We debounce writes so a burst of edits does not turn into a burst of DB work.
 */
export function scheduleRoomPersist(
  roomId: number,
  shapes: Shape[],
  delayMs = 180,
) {
  pendingPersistShapes.set(roomId, shapes);

  const existingTimer = pendingPersistTimer.get(roomId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    pendingPersistTimer.delete(roomId);
    void persistQueuedRoom(roomId);
  }, delayMs);

  pendingPersistTimer.set(roomId, timer);
}

/**
 * Persist through RabbitMQ so DB writes are durable and replayable.
 * Falls back to in-process debounce persistence if the queue is unavailable.
 */
export async function enqueueRoomPersist(
  roomId: number,
  version: number,
  shapes: Shape[],
) {
  const now = Date.now();
  if (now < durablePersistRetryAfterMs) {
    scheduleRoomPersist(roomId, shapes);
    return;
  }

  try {
    await publishRoomPersistJob({
      jobId: randomUUID(),
      roomId,
      version,
      shapes,
      enqueuedAtMs: Date.now(),
    });
    durablePersistFailureCount = 0;
    durablePersistRetryAfterMs = 0;
  } catch (error) {
    durablePersistFailureCount += 1;
    const delayMs = getDurablePersistCooldownMs(durablePersistFailureCount);
    durablePersistRetryAfterMs = Date.now() + delayMs;

    if (
      durablePersistFailureCount === 1 ||
      durablePersistFailureCount % 5 === 0
    ) {
      console.error(
        `[WS] Failed to enqueue room ${roomId} persist job; using local fallback`,
        {
          failureCount: durablePersistFailureCount,
          retryAfterMs: delayMs,
          error,
        },
      );
    }

    scheduleRoomPersist(roomId, shapes);
  }
}
