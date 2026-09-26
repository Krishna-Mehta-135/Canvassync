/**
 * useCanvasSync
 *
 * Manages bidirectional WebSocket sync between canvas state and server.
 *
 * - On component mount: join room, receive sync_init
 * - On local changes: throttle-send canvas_snapshot
 * - On remote updates: hydrate state without notification loop
 *
 * Key optimisations in this version:
 * - latestShapesRef: updated synchronously (before React re-renders) so the
 *   RemotePresenceLayer can read frame-accurate shape positions every RAF.
 * - Drag-burst detection: when consecutive snapshots arrive within
 *   DRAG_BURST_WINDOW_MS we temporarily double in-flight budget and halve the
 *   send interval so dragged shapes reach peers with minimal lag.
 * - Rate-limit backoff: exponential wait after sync_error[rate limit] instead
 *   of immediately re-queuing (avoids flood → reject → retry loops).
 */

import { useEffect, useRef, useCallback, useState } from "react";
import type { CanvasState, Shape } from "@repo/canvas-engine";
import type {
  WsMessage,
  ServerMessage,
  RoomSyncState,
  RoomPresenceState,
  PersistedChatMessage,
  ClientMessage,
  EphemeralEvent,
} from "@repo/common";
import {
  getCanvasCrdtMetadata,
  mergeCanvasCrdtSnapshot,
  reconcileLocalCanvasCrdtSnapshot,
  type CanvasCrdtMetadata,
} from "@repo/common";
import type { Tool } from "@repo/canvas-engine";
import { apiClient } from "../app/lib/apiClient";
import { HTTP_BACKEND } from "../config";

const WS_SYNC_DEBUG = process.env.NEXT_PUBLIC_WS_SYNC_DEBUG === "true";
const SNAPSHOT_MIN_SEND_INTERVAL_MS = Number(
  process.env.NEXT_PUBLIC_WS_SNAPSHOT_MIN_SEND_INTERVAL_MS ?? 16,
);
const WS_MAX_IN_FLIGHT_SNAPSHOTS = Number(
  process.env.NEXT_PUBLIC_WS_MAX_IN_FLIGHT_SNAPSHOTS ?? 3,
);
const REMOTE_HYDRATE_IDLE_GRACE_MS = Number(
  process.env.NEXT_PUBLIC_WS_REMOTE_HYDRATE_IDLE_GRACE_MS ?? 6,
);

/**
 * During an active drag burst (consecutive snapshots within this window)
 * we temporarily relax the throttle so peer canvases stay smooth.
 */
const DRAG_BURST_WINDOW_MS = 120;
const DRAG_BURST_MIN_INTERVAL_MS = 8;
const DRAG_BURST_MAX_IN_FLIGHT = 6;

export type EphemeralBroadcast = Extract<
  ServerMessage,
  { type: "ephemeral_broadcast" }
>;
type EphemeralListener = (message: EphemeralBroadcast) => void;

type PendingRemoteSnapshot = {
  roomId: number;
  version: number;
  shapes: Shape[];
  senderId?: string;
  deletedShapeIds?: string[];
  deletionMeta?: CanvasCrdtMetadata | null;
};

type PendingLocalSnapshot = {
  shapes: Shape[];
  deletedShapeIds: string[];
  deletionMeta: CanvasCrdtMetadata | null;
};

interface UseCanvasSyncOptions {
  roomId: number;
  state: CanvasState | null;
  enabled?: boolean;
  /** Local selection IDs mirrored to collaborators as presence state. */
  localSelectionIds: string[];
  /** Current local tool used to describe what the user is making. */
  localTool: Tool;
}

export type SyncTimelineEntry = {
  id: string;
  at: string;
  type: string;
  detail: string;
};

function areStringArraysEqual(left: string[], right: string[]) {
  if (left === right) return true;
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function arePresenceStatesEqual(
  left: RoomPresenceState,
  right: RoomPresenceState,
) {
  if (left === right) return true;
  if (left.roomId !== right.roomId) return false;
  if (left.connectedUsersCount !== right.connectedUsersCount) return false;
  if (left.presences.length !== right.presences.length) return false;

  for (let index = 0; index < left.presences.length; index += 1) {
    const leftPresence = left.presences[index];
    const rightPresence = right.presences[index];

    if (!leftPresence || !rightPresence) return false;
    if (leftPresence.userId !== rightPresence.userId) return false;
    if (leftPresence.userName !== rightPresence.userName) return false;
    if (leftPresence.tool !== rightPresence.tool) return false;
    if (
      !areStringArraysEqual(leftPresence.selectedIds, rightPresence.selectedIds)
    )
      return false;

    const leftCursor = leftPresence.cursor;
    const rightCursor = rightPresence.cursor;
    if (leftCursor === rightCursor) continue;
    if (!leftCursor || !rightCursor) return false;
    if (leftCursor.x !== rightCursor.x || leftCursor.y !== rightCursor.y)
      return false;
  }

  return true;
}

/**
 * Synchronizes canvas state and room presence with the websocket backend.
 */
export function useCanvasSync({
  roomId,
  state,
  enabled = true,
  localSelectionIds,
  localTool,
}: UseCanvasSyncOptions) {
  const [isConnected, setIsConnected] = useState(false);
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  const [presenceState, setPresenceState] = useState<RoomPresenceState>({
    roomId,
    connectedUsersCount: 0,
    presences: [],
  });
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [websocketLatencyMs, setWebsocketLatencyMs] = useState<number | null>(
    null,
  );
  const [inFlightSnapshotCount, setInFlightSnapshotCount] = useState(0);
  const [eventTimeline, setEventTimeline] = useState<SyncTimelineEntry[]>([]);
  const [realtimeChatMessages, setRealtimeChatMessages] = useState<
    PersistedChatMessage[]
  >([]);

  const wsRef = useRef<WebSocket | null>(null);
  const isConnectedRef = useRef(false);
  const isApplyingRemoteRef = useRef(false);
  const hasJoinedRoomRef = useRef(false);
  const syncStateRef = useRef<RoomSyncState>({
    roomId,
    version: 0,
    shapes: [],
  });
  const pendingSyncRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSyncRafRef = useRef<number | null>(null);
  const pendingPresenceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightSnapshotCountRef = useRef(0);
  const queuedSnapshotRef = useRef<PendingLocalSnapshot | null>(null);
  const snapshotSentAtRef = useRef<number | null>(null);
  const lastSnapshotSentAtRef = useRef(0);
  const optimisticSnapshotVersionRef = useRef(0);
  const lastLocalEditAtRef = useRef(0);
  const pendingRemoteSnapshotRef = useRef<PendingRemoteSnapshot | null>(null);
  const pendingRemoteHydrateTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const remoteHydrateRafRef = useRef<number | null>(null);

  /**
   * Live shapes ref — updated synchronously every time shapes are hydrated,
   * before any React re-render.  RemotePresenceLayer reads this every frame
   * so selection boxes are always positioned against the current shape state
   * rather than waiting for a React re-render cycle.
   */
  const latestShapesRef = useRef<Shape[]>([]);

  // Drag-burst detection.
  const lastBurstSnapshotAtRef = useRef(0);
  const isDragBurstActiveRef = useRef(false);
  const dragBurstCooldownTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const localSelectionIdsRef = useRef<string[]>(localSelectionIds);
  const localToolRef = useRef<Tool>(localTool);
  const crdtClientIdRef = useRef<string>(
    `client-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`,
  );
  const crdtClockRef = useRef(0);
  const previousCrdtShapesRef = useRef<Shape[]>([]);
  const crdtTombstonesRef = useRef<Map<string, CanvasCrdtMetadata>>(new Map());

  // Rate-limit backoff state.
  const rateLimitBackoffUntilRef = useRef(0);
  const rateLimitBackoffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const getEffectiveMinInterval = () =>
    isDragBurstActiveRef.current
      ? DRAG_BURST_MIN_INTERVAL_MS
      : SNAPSHOT_MIN_SEND_INTERVAL_MS;

  const getEffectiveMaxInFlight = () =>
    isDragBurstActiveRef.current
      ? DRAG_BURST_MAX_IN_FLIGHT
      : WS_MAX_IN_FLIGHT_SNAPSHOTS;

  const nextCrdtClock = useCallback(() => {
    crdtClockRef.current += 1;
    return crdtClockRef.current;
  }, []);

  const observeCrdtClock = useCallback((shapes: Shape[]) => {
    for (const shape of shapes) {
      crdtClockRef.current = Math.max(
        crdtClockRef.current,
        getCanvasCrdtMetadata(shape).clock,
      );
    }
  }, []);

  useEffect(() => {
    localSelectionIdsRef.current = localSelectionIds;
  }, [localSelectionIds]);

  useEffect(() => {
    localToolRef.current = localTool;
  }, [localTool]);

  const appendTimelineEvent = useCallback((type: string, detail: string) => {
    if (!WS_SYNC_DEBUG) return;

    const now = new Date();
    const nextEvent: SyncTimelineEntry = {
      id: `${now.getTime()}-${Math.random().toString(16).slice(2, 8)}`,
      at: now.toLocaleTimeString(),
      type,
      detail,
    };
    setEventTimeline((previous) => [...previous.slice(-59), nextEvent]);
  }, []);

  const appendRealtimeChatMessage = useCallback(
    (message: PersistedChatMessage) => {
      setRealtimeChatMessages((previous) => {
        if (previous.some((existing) => existing.id === message.id)) {
          return previous;
        }

        return [...previous, message].slice(-240);
      });
    },
    [],
  );

  const ephemeralListenersRef = useRef<Set<EphemeralListener>>(new Set());

  /** Subscribes to cursor/reaction/viewport events without React re-renders. */
  const subscribeEphemeral = useCallback((listener: EphemeralListener) => {
    ephemeralListenersRef.current.add(listener);
    return () => {
      ephemeralListenersRef.current.delete(listener);
    };
  }, []);

  const sendEphemeral = useCallback(
    (event: EphemeralEvent) => {
      const socket = wsRef.current;
      if (
        !socket ||
        socket.readyState !== WebSocket.OPEN ||
        !isConnectedRef.current ||
        !hasJoinedRoomRef.current
      ) {
        return false;
      }

      const message: WsMessage = { type: "ephemeral", roomId, event };
      socket.send(JSON.stringify(message));
      return true;
    },
    [roomId],
  );

  const sendWsMessage = useCallback((message: ClientMessage) => {
    if (
      !wsRef.current ||
      wsRef.current.readyState !== WebSocket.OPEN ||
      !isConnectedRef.current ||
      !hasJoinedRoomRef.current
    ) {
      return false;
    }

    wsRef.current.send(JSON.stringify(message));
    return true;
  }, []);

  const syncInFlightCounter = useCallback(() => {
    const count =
      inFlightSnapshotCountRef.current + (queuedSnapshotRef.current ? 1 : 0);
    setInFlightSnapshotCount(count);
  }, []);

  const cancelScheduledRemoteHydrate = useCallback(() => {
    if (pendingRemoteHydrateTimerRef.current) {
      clearTimeout(pendingRemoteHydrateTimerRef.current);
      pendingRemoteHydrateTimerRef.current = null;
    }
    if (remoteHydrateRafRef.current !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(remoteHydrateRafRef.current);
      remoteHydrateRafRef.current = null;
    }
  }, []);

  const cancelScheduledSnapshotFlush = useCallback(() => {
    if (pendingSyncRef.current) {
      clearTimeout(pendingSyncRef.current);
      pendingSyncRef.current = null;
    }
    if (pendingSyncRafRef.current !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(pendingSyncRafRef.current);
      pendingSyncRafRef.current = null;
    }
  }, []);

  const scheduleRemoteHydrate = useCallback(() => {
    if (!state) return;

    cancelScheduledRemoteHydrate();

    const applyLatestRemoteSnapshot = () => {
      const pending = pendingRemoteSnapshotRef.current;
      if (!pending) return;

      const sinceLastLocalEditMs = Date.now() - lastLocalEditAtRef.current;
      if (sinceLastLocalEditMs < REMOTE_HYDRATE_IDLE_GRACE_MS) {
        const waitMs = Math.max(
          1,
          REMOTE_HYDRATE_IDLE_GRACE_MS - sinceLastLocalEditMs,
        );
        pendingRemoteHydrateTimerRef.current = setTimeout(() => {
          scheduleRemoteHydrate();
        }, waitMs);
        return;
      }

      pendingRemoteSnapshotRef.current = null;
      if (pending.deletedShapeIds && pending.deletionMeta) {
        const nextTombstones = new Map(crdtTombstonesRef.current);
        for (const id of pending.deletedShapeIds) {
          nextTombstones.set(id, pending.deletionMeta);
        }
        crdtTombstonesRef.current = nextTombstones;
      }
      const hasPendingLocalWork =
        Boolean(queuedSnapshotRef.current) ||
        inFlightSnapshotCountRef.current > 0;
      const nextShapes =
        hasPendingLocalWork && state
          ? mergeCanvasCrdtSnapshot(
              pending.shapes,
              state.getShapes(),
              pending.deletedShapeIds && pending.deletionMeta
                ? pending.deletedShapeIds.map((id) => ({
                    id,
                    meta: pending.deletionMeta!,
                  }))
                : [],
              crdtTombstonesRef.current,
            ).shapes
          : pending.shapes;
      syncStateRef.current = {
        roomId: pending.roomId,
        version: pending.version,
        shapes: nextShapes,
      };

      // Update the live ref BEFORE hydrateShapes fires React subscribers —
      // ensures RemotePresenceLayer reads the correct positions this frame.
      latestShapesRef.current = nextShapes;
      previousCrdtShapesRef.current = nextShapes;
      observeCrdtClock(nextShapes);

      isApplyingRemoteRef.current = true;
      state.hydrateShapes(nextShapes);
      isApplyingRemoteRef.current = false;

      appendTimelineEvent(
        "snapshot_broadcast",
        `v${pending.version}${pending.senderId ? ` from ${pending.senderId}` : ""}`,
      );
    };

    if (typeof window === "undefined") {
      applyLatestRemoteSnapshot();
      return;
    }

    remoteHydrateRafRef.current = window.requestAnimationFrame(() => {
      remoteHydrateRafRef.current = null;
      applyLatestRemoteSnapshot();
    });
  }, [
    appendTimelineEvent,
    cancelScheduledRemoteHydrate,
    observeCrdtClock,
    state,
  ]);

  const WS_BACKEND_URL =
    typeof window !== "undefined"
      ? (() => {
          if (process.env.NEXT_PUBLIC_WS_URL) {
            return process.env.NEXT_PUBLIC_WS_URL;
          }
          const backendHttpUrl = new URL(HTTP_BACKEND);
          const wsProtocol =
            backendHttpUrl.protocol === "https:" ? "wss:" : "ws:";
          // In production (https), the GCP Load Balancer handles the default port (443)
          // and routes it to 8081. In local dev (http), connect explicitly to 8081.
          const port = backendHttpUrl.protocol === "https:" ? "" : ":8081";
          return `${wsProtocol}//${backendHttpUrl.hostname}${port}`;
        })()
      : "ws://localhost:8081";

  const flushQueuedSnapshot = useCallback(() => {
    if (
      !wsRef.current ||
      wsRef.current.readyState !== WebSocket.OPEN ||
      !hasJoinedRoomRef.current ||
      isApplyingRemoteRef.current ||
      inFlightSnapshotCountRef.current >= getEffectiveMaxInFlight()
    ) {
      return;
    }

    // Respect rate-limit backoff window.
    if (
      rateLimitBackoffUntilRef.current > 0 &&
      Date.now() < rateLimitBackoffUntilRef.current
    ) {
      return;
    }

    const now = Date.now();
    const elapsedSinceLastSend = now - lastSnapshotSentAtRef.current;
    if (elapsedSinceLastSend < getEffectiveMinInterval()) {
      return;
    }

    const queuedSnapshot = queuedSnapshotRef.current;
    if (!queuedSnapshot) {
      syncInFlightCounter();
      return;
    }

    const messageVersion = optimisticSnapshotVersionRef.current;
    optimisticSnapshotVersionRef.current += 1;

    queuedSnapshotRef.current = null;
    inFlightSnapshotCountRef.current += 1;
    snapshotSentAtRef.current = Date.now();
    lastSnapshotSentAtRef.current = snapshotSentAtRef.current;
    appendTimelineEvent(
      "snapshot_send",
      `v${messageVersion} (${queuedSnapshot.shapes.length} shapes)`,
    );
    syncInFlightCounter();

    const message: WsMessage = {
      type: "canvas_snapshot",
      roomId,
      version: messageVersion,
      shapes: queuedSnapshot.shapes,
      deletedShapeIds: queuedSnapshot.deletedShapeIds,
      deletionMeta: queuedSnapshot.deletionMeta,
    };

    wsRef.current.send(JSON.stringify(message));
  }, [appendTimelineEvent, roomId, syncInFlightCounter]);

  const scheduleSnapshotFlush = useCallback(() => {
    if (pendingSyncRafRef.current !== null || typeof window === "undefined")
      return;

    const tick = () => {
      pendingSyncRafRef.current = null;
      const hadQueuedSnapshot = Boolean(queuedSnapshotRef.current);
      flushQueuedSnapshot();
      if (queuedSnapshotRef.current && hadQueuedSnapshot) {
        pendingSyncRafRef.current = window.requestAnimationFrame(tick);
      }
    };

    pendingSyncRafRef.current = window.requestAnimationFrame(tick);
  }, [flushQueuedSnapshot]);

  /**
   * Track drag-burst activity.  When snapshots arrive within DRAG_BURST_WINDOW_MS
   * of each other we activate burst mode which loosens the throttle.
   */
  const touchDragBurst = useCallback(() => {
    const now = Date.now();
    const sinceLastBurst = now - lastBurstSnapshotAtRef.current;
    lastBurstSnapshotAtRef.current = now;

    if (sinceLastBurst < DRAG_BURST_WINDOW_MS) {
      isDragBurstActiveRef.current = true;

      if (dragBurstCooldownTimerRef.current) {
        clearTimeout(dragBurstCooldownTimerRef.current);
      }
      dragBurstCooldownTimerRef.current = setTimeout(() => {
        isDragBurstActiveRef.current = false;
        dragBurstCooldownTimerRef.current = null;
      }, DRAG_BURST_WINDOW_MS * 2);
    }
  }, []);

  // Queue latest snapshot and send when no snapshot is currently in flight.
  const sendCanvasSnapshot = useCallback(
    (shapes: Shape[]) => {
      const reconciled = reconcileLocalCanvasCrdtSnapshot(
        previousCrdtShapesRef.current,
        shapes,
        crdtClientIdRef.current,
        nextCrdtClock,
      );
      previousCrdtShapesRef.current = reconciled.shapes;
      queuedSnapshotRef.current = {
        shapes: reconciled.shapes,
        deletedShapeIds: reconciled.deletedShapeIds,
        deletionMeta: reconciled.deletionMeta,
      };
      syncInFlightCounter();
      touchDragBurst();
      cancelScheduledSnapshotFlush();

      // Flush immediately if budget and interval allow.
      const rateLimitCleared =
        rateLimitBackoffUntilRef.current === 0 ||
        Date.now() >= rateLimitBackoffUntilRef.current;
      const canFlushNow =
        rateLimitCleared &&
        inFlightSnapshotCountRef.current < getEffectiveMaxInFlight() &&
        Date.now() - lastSnapshotSentAtRef.current >= getEffectiveMinInterval();

      if (canFlushNow) {
        flushQueuedSnapshot();
        return;
      }

      scheduleSnapshotFlush();
    },
    [
      cancelScheduledSnapshotFlush,
      flushQueuedSnapshot,
      nextCrdtClock,
      scheduleSnapshotFlush,
      syncInFlightCounter,
      touchDragBurst,
    ],
  );

  /**
   * Sends local selection/tool state to the room presence channel.
   */
  const sendPresenceSnapshot = useCallback(() => {
    if (pendingPresenceRef.current) {
      clearTimeout(pendingPresenceRef.current);
    }

    pendingPresenceRef.current = setTimeout(() => {
      if (
        !wsRef.current ||
        wsRef.current.readyState !== WebSocket.OPEN ||
        !isConnectedRef.current ||
        !hasJoinedRoomRef.current
      ) {
        return;
      }

      const message: WsMessage = {
        type: "update_presence",
        roomId,
        cursor: null,
        selectedIds: localSelectionIdsRef.current,
        tool: localToolRef.current,
      };

      wsRef.current.send(JSON.stringify(message));
    }, 80);
  }, [roomId]);

  // Subscribe to local canvas changes.
  useEffect(() => {
    if (!enabled || !state) return;

    const unsubscribe = state.subscribe((shapes) => {
      if (!isApplyingRemoteRef.current) {
        lastLocalEditAtRef.current = Date.now();
        // Keep the live ref current for every local edit too.
        latestShapesRef.current = shapes;
        sendCanvasSnapshot(shapes);
      }
    });

    return () => {
      unsubscribe();
      if (pendingSyncRef.current) {
        clearTimeout(pendingSyncRef.current);
      }
    };
  }, [state, enabled, sendCanvasSnapshot, sendPresenceSnapshot]);

  useEffect(() => {
    if (!enabled || !state) return;
    if (!isConnectedRef.current || !currentUserId) return;

    sendPresenceSnapshot();

    return () => {
      if (pendingPresenceRef.current) {
        clearTimeout(pendingPresenceRef.current);
      }
    };
  }, [enabled, state, currentUserId, localSelectionIds, sendPresenceSnapshot]);

  // Initialize WebSocket connection.
  useEffect(() => {
    if (!enabled || !state) return;

    setRealtimeChatMessages([]);

    const crdtClientId = crdtClientIdRef.current;
    let isCleanedUp = false;

    // Ensure accessToken is fresh before opening WS — it expires in 15m and
    // the WS upgrade has no automatic refresh unlike HTTP requests via apiClient.
    const connectWebSocket = async () => {
      // Get a short-lived WS handshake token — avoids cookie issues on mobile
      let wsUrl = WS_BACKEND_URL;
      try {
        const res = await apiClient.get(`${HTTP_BACKEND}/auth/ws-token`);
        const token = (res.data as { data?: { token?: string } })?.data?.token;
        if (token) {
          wsUrl = `${WS_BACKEND_URL}${WS_BACKEND_URL.includes("?") ? "&" : "?"}token=${token}`;
        }
      } catch {
        // Fall back to cookie-based auth (works on desktop)
      }

      if (isCleanedUp) return;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (WS_SYNC_DEBUG) console.log("[WS] Connected, joining room", roomId);
        appendTimelineEvent("socket_open", `joining room ${roomId}`);
        setLastSyncError(null);
        hasJoinedRoomRef.current = false;
        isConnectedRef.current = true;
        setIsConnected(true);
        const joinMsg: WsMessage = { type: "join_room", roomId };
        ws.send(JSON.stringify(joinMsg));
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as ServerMessage;

          if (message.type === "room_joined") {
            if (WS_SYNC_DEBUG) {
              console.log(
                "[WS] Joined room, version:",
                message.version,
                "shapes:",
                message.shapes.length,
              );
            }
            syncStateRef.current = {
              roomId: message.roomId,
              version: message.version,
              shapes: message.shapes,
            };
            optimisticSnapshotVersionRef.current = message.version;
            hasJoinedRoomRef.current = true;
            inFlightSnapshotCountRef.current = 0;
            setCurrentUserId(message.userId);
            setPresenceState((previous) => {
              const nextPresenceState: RoomPresenceState = {
                roomId: message.roomId,
                connectedUsersCount: message.connectedUsersCount,
                presences: message.presences,
              };

              return arePresenceStatesEqual(previous, nextPresenceState)
                ? previous
                : nextPresenceState;
            });
            setLastSyncError(null);
            isConnectedRef.current = true;
            setIsConnected(true);
            appendTimelineEvent(
              "room_joined",
              `v${message.version} (${message.shapes.length} shapes)`,
            );
            syncInFlightCounter();

            // Update live ref first, then hydrate.
            pendingRemoteSnapshotRef.current = null;
            cancelScheduledRemoteHydrate();

            // If we have a preserved local snapshot (e.g. from a version-mismatch
            // recovery), we apply the server state first to sync version metadata,
            // then IMMEDIATELY re-apply the local state so the canvas never shows
            // the old server position.  isApplyingRemoteRef stays true across both
            // calls so no sendCanvasSnapshot fires for the intermediate server state.
            const savedLocalShapes = queuedSnapshotRef.current;

            isApplyingRemoteRef.current = true;
            latestShapesRef.current = message.shapes;
            previousCrdtShapesRef.current = message.shapes;
            observeCrdtClock(message.shapes);
            state.hydrateShapes(message.shapes);

            if (savedLocalShapes) {
              // Re-apply the user's latest local state so the shape snaps back
              // to where they left it — not to the server's stale position.
              latestShapesRef.current = savedLocalShapes.shapes;
              previousCrdtShapesRef.current = savedLocalShapes.shapes;
              observeCrdtClock(savedLocalShapes.shapes);
              state.hydrateShapes(savedLocalShapes.shapes);
            }

            isApplyingRemoteRef.current = false;

            flushQueuedSnapshot();
          } else if (message.type === "canvas_snapshot_broadcast") {
            if (WS_SYNC_DEBUG) {
              console.log(
                "[WS] Received snapshot from",
                message.senderId,
                "version:",
                message.version,
              );
            }

            // Keep the live overlay ref current as soon as the snapshot arrives.
            // The actual CanvasState hydrate still goes through the deferred path
            // below, so local drag churn remains protected, but remote selection
            // boxes and attached indicators can track the newest geometry every frame.
            latestShapesRef.current = message.shapes;
            observeCrdtClock(message.shapes);

            pendingRemoteSnapshotRef.current = {
              roomId: message.roomId,
              version: message.version,
              shapes: message.shapes,
              senderId: message.senderId,
              deletedShapeIds: message.deletedShapeIds,
              deletionMeta: message.deletionMeta,
            };
            scheduleRemoteHydrate();
          } else if (message.type === "canvas_snapshot_ack") {
            syncStateRef.current = {
              roomId: message.roomId,
              version: message.version,
              shapes: syncStateRef.current.shapes,
            };
            inFlightSnapshotCountRef.current = Math.max(
              0,
              inFlightSnapshotCountRef.current - 1,
            );
            optimisticSnapshotVersionRef.current = Math.max(
              optimisticSnapshotVersionRef.current,
              message.version + 1,
            );
            if (snapshotSentAtRef.current !== null) {
              const latency = Math.max(0, Date.now() - snapshotSentAtRef.current);
              setWebsocketLatencyMs(latency);
              appendTimelineEvent(
                "snapshot_ack",
                `v${message.version} (${latency}ms)`,
              );
              snapshotSentAtRef.current = null;
            } else {
              appendTimelineEvent("snapshot_ack", `v${message.version}`);
            }
            syncInFlightCounter();
            setLastSyncError(null);
            scheduleSnapshotFlush();
          } else if (message.type === "room_presence_state") {
            setPresenceState((previous) => {
              const nextPresenceState: RoomPresenceState = {
                roomId: message.roomId,
                connectedUsersCount: message.connectedUsersCount,
                presences: message.presences,
              };

              return arePresenceStatesEqual(previous, nextPresenceState)
                ? previous
                : nextPresenceState;
            });
          } else if (message.type === "ephemeral_broadcast") {
            for (const listener of ephemeralListenersRef.current) {
              listener(message);
            }
          } else if (message.type === "chat_message_created") {
            appendRealtimeChatMessage(message.message);
          } else if (message.type === "sync_error") {
            if (WS_SYNC_DEBUG) console.warn("[WS] Sync error:", message.reason);
            appendTimelineEvent("sync_error", message.reason);

            const reasonLower = message.reason.toLowerCase();
            const isTransientSyncError =
              reasonLower.includes("version mismatch") ||
              reasonLower.includes("rate limit") ||
              (!hasJoinedRoomRef.current &&
                (reasonLower.includes("forbidden") ||
                  reasonLower.includes("not active")));

            if (!isTransientSyncError) {
              setLastSyncError(message.reason);
            }

            inFlightSnapshotCountRef.current = 0;
            syncInFlightCounter();

            // Version mismatch: server will push authoritative room_joined.
            // IMPORTANT: Do NOT null out queuedSnapshotRef here — that would
            // lose the user's latest local position and cause the shape to
            // teleport back to wherever the server was when it rejected us.
            //
            // Instead, capture the latest local canvas state (if no snapshot is
            // already queued) and hold it.  When room_joined arrives it resets
            // optimisticSnapshotVersionRef to the server's version, then
            // flushQueuedSnapshot() re-sends our latest state with that version.
            if (reasonLower.includes("version mismatch")) {
              if (!queuedSnapshotRef.current && state) {
                // Preserve the current canvas position so it survives the resync.
                const reconciled = reconcileLocalCanvasCrdtSnapshot(
                  previousCrdtShapesRef.current,
                  state.getShapes(),
                  crdtClientIdRef.current,
                  nextCrdtClock,
                );
                previousCrdtShapesRef.current = reconciled.shapes;
                queuedSnapshotRef.current = {
                  shapes: reconciled.shapes,
                  deletedShapeIds: reconciled.deletedShapeIds,
                  deletionMeta: reconciled.deletionMeta,
                };
              }
              // Cancel any pending flush timer — room_joined will trigger a flush.
              if (pendingSyncRef.current) {
                clearTimeout(pendingSyncRef.current);
                pendingSyncRef.current = null;
              }
              return;
            }

            // Rate limit: exponential backoff before retrying.
            if (reasonLower.includes("rate limit")) {
              const alreadyWaiting =
                rateLimitBackoffUntilRef.current > 0 &&
                Date.now() < rateLimitBackoffUntilRef.current;
              const nextBackoffMs = alreadyWaiting
                ? Math.min(
                    (rateLimitBackoffUntilRef.current - Date.now()) * 2,
                    4000,
                  )
                : 250;
              rateLimitBackoffUntilRef.current = Date.now() + nextBackoffMs;

              if (rateLimitBackoffTimerRef.current) {
                clearTimeout(rateLimitBackoffTimerRef.current);
              }
              rateLimitBackoffTimerRef.current = setTimeout(() => {
                rateLimitBackoffUntilRef.current = 0;
                rateLimitBackoffTimerRef.current = null;
                scheduleSnapshotFlush();
              }, nextBackoffMs);
              return;
            }

            // Other transient errors: retry with next flush.
            scheduleSnapshotFlush();
          }
        } catch (err) {
          if (WS_SYNC_DEBUG) console.error("[WS] Failed to parse message:", err);
        }
      };

      ws.onerror = () => {
        if (WS_SYNC_DEBUG) console.warn("[WS] WebSocket connection error");
        appendTimelineEvent("socket_error", "websocket connection error");
        setLastSyncError("WebSocket connection error");
      };

      ws.onclose = (event) => {
        if (WS_SYNC_DEBUG) console.log("[WS] Disconnected");
        appendTimelineEvent("socket_close", event.reason || `code ${event.code}`);
        if (event.code === 1008) {
          // Token expired mid-session — refresh silently so the next reconnect
          // attempt (triggered by the useEffect re-run) succeeds.
          apiClient
            .post(`${HTTP_BACKEND}/auth/refresh-token`, {})
            .catch(() => {
              // Refresh failed — user session truly expired, redirect to signin.
              if (typeof window !== "undefined") {
                window.location.href = "/signin";
              }
            });
          setLastSyncError(event.reason || "WebSocket authentication failed");
        }
        hasJoinedRoomRef.current = false;
        isConnectedRef.current = false;
        setIsConnected(false);
      };
    };

    // Refresh token if needed, then connect.
    apiClient
      .get(`${HTTP_BACKEND}/auth/current-user`)
      .catch(() => apiClient.post(`${HTTP_BACKEND}/auth/refresh-token`, {}))
      .finally(connectWebSocket);

    return () => {
      isCleanedUp = true;
      // Flush latest local snapshot before closing so navigation does not drop edits.
      if (
        isConnectedRef.current &&
        wsRef.current &&
        wsRef.current.readyState === WebSocket.OPEN &&
        state &&
        !isApplyingRemoteRef.current
      ) {
        try {
          const reconciled = reconcileLocalCanvasCrdtSnapshot(
            previousCrdtShapesRef.current,
            state.getShapes(),
            crdtClientId,
            nextCrdtClock,
          );
          const message: WsMessage = {
            type: "canvas_snapshot",
            roomId,
            version: syncStateRef.current.version,
            shapes: reconciled.shapes,
            deletedShapeIds: reconciled.deletedShapeIds,
            deletionMeta: reconciled.deletionMeta,
          };
          wsRef.current.send(JSON.stringify(message));
        } catch (error) {
          if (WS_SYNC_DEBUG)
            console.warn("[WS] Failed to flush snapshot during cleanup", error);
        }
      }

      if (pendingSyncRef.current) clearTimeout(pendingSyncRef.current);
      if (pendingSyncRafRef.current !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(pendingSyncRafRef.current);
        pendingSyncRafRef.current = null;
      }
      if (pendingPresenceRef.current) clearTimeout(pendingPresenceRef.current);
      if (dragBurstCooldownTimerRef.current) {
        clearTimeout(dragBurstCooldownTimerRef.current);
        dragBurstCooldownTimerRef.current = null;
      }
      if (rateLimitBackoffTimerRef.current) {
        clearTimeout(rateLimitBackoffTimerRef.current);
        rateLimitBackoffTimerRef.current = null;
      }

      cancelScheduledRemoteHydrate();
      pendingRemoteSnapshotRef.current = null;
      inFlightSnapshotCountRef.current = 0;
      queuedSnapshotRef.current = null;
      snapshotSentAtRef.current = null;
      lastSnapshotSentAtRef.current = 0;
      optimisticSnapshotVersionRef.current = 0;
      isDragBurstActiveRef.current = false;
      rateLimitBackoffUntilRef.current = 0;
      syncInFlightCounter();
      hasJoinedRoomRef.current = false;

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN)
        wsRef.current.close();
    };
  }, [
    roomId,
    enabled,
    WS_BACKEND_URL,
    state,
    flushQueuedSnapshot,
    scheduleSnapshotFlush,
    appendTimelineEvent,
    syncInFlightCounter,
    cancelScheduledRemoteHydrate,
    scheduleRemoteHydrate,
    appendRealtimeChatMessage,
    nextCrdtClock,
    observeCrdtClock,
  ]);

  return {
    isConnected,
    syncVersion: syncStateRef.current.version,
    lastSyncError,
    presenceState,
    connectedUsersCount: presenceState.connectedUsersCount,
    currentUserId,
    websocketLatencyMs,
    inFlightSnapshotCount,
    eventTimeline,
    realtimeChatMessages,
    sendWsMessage,
    sendEphemeral,
    subscribeEphemeral,
    manualHydrate: (shapes: Shape[]) => {
      if (!state) return;
      isApplyingRemoteRef.current = true;
      try {
        state.hydrateShapes(shapes);
        latestShapesRef.current = shapes;
        previousCrdtShapesRef.current = shapes;
        observeCrdtClock(shapes);
      } finally {
        isApplyingRemoteRef.current = false;
      }
    },
    /**
     * Live shapes ref — always current, updated synchronously before any
     * React re-render.  Pass this to RemotePresenceLayer so selection boxes
     * are frame-locked to the canvas engine, not to React render batches.
     */
    latestShapesRef,
  };
}
