"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { convertToPoints, type Shape } from "@repo/canvas-engine";
import type { RoomPresenceState } from "@repo/common";

type ViewportLike = { x: number; y: number; scale: number };

type RemotePresenceLayerProps = {
  presenceState: RoomPresenceState;
  currentUserId: string | null;
  viewportRef: React.RefObject<ViewportLike | null>;
  shapesRef: React.RefObject<Shape[]>;
  isDark: boolean;
};

type PresenceRender = {
  userId: string;
  userName: string;
  selectedIds: string[];
  color: string;
  tool: string | null;
};

type SelectionBounds = { x1: number; y1: number; x2: number; y2: number };

const PRESENCE_COLORS = [
  "#f97316",
  "#22c55e",
  "#38bdf8",
  "#fb7185",
  "#eab308",
  "#c084fc",
];
const ACTIVE_WINDOW_MS = 2200;
const ACTIVITY_MOVE_EPSILON = 0.75;

function hashString(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getColor(userId: string) {
  return (
    PRESENCE_COLORS[hashString(userId) % PRESENCE_COLORS.length] ??
    PRESENCE_COLORS[0]!
  );
}

export { getColor as getPresenceColor };

function getSelectionBounds(
  shapeById: Map<string, Shape>,
  selectedIds: string[],
): SelectionBounds | null {
  const first = selectedIds
    .map((id) => shapeById.get(id))
    .find((s): s is Shape => Boolean(s));
  if (!first) return null;

  const f = convertToPoints(first);
  let x1 = f.x1,
    y1 = f.y1,
    x2 = f.x2,
    y2 = f.y2;

  for (const id of selectedIds) {
    const s = shapeById.get(id);
    if (!s || s.id === first.id) continue;
    const b = convertToPoints(s);
    x1 = Math.min(x1, b.x1);
    y1 = Math.min(y1, b.y1);
    x2 = Math.max(x2, b.x2);
    y2 = Math.max(y2, b.y2);
  }
  return { x1, y1, x2, y2 };
}

function boundsChanged(
  a: SelectionBounds | null,
  b: SelectionBounds | null,
): boolean {
  if (!a || !b) return a !== b;
  return (
    Math.abs(a.x1 - b.x1) > ACTIVITY_MOVE_EPSILON ||
    Math.abs(a.y1 - b.y1) > ACTIVITY_MOVE_EPSILON ||
    Math.abs(a.x2 - b.x2) > ACTIVITY_MOVE_EPSILON ||
    Math.abs(a.y2 - b.y2) > ACTIVITY_MOVE_EPSILON
  );
}

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

/**
 * Renders remote collaborators' selection outlines above the canvas.
 *
 * Architecture:
 * - React state controls WHICH overlays exist (structural, ≤4×/sec).
 * - The RAF loop mutates overlay div styles directly — zero React cost/frame.
 * - Positions are exponentially eased toward the target (lerp) so rapid remote
 *   moves stream smoothly instead of teleporting on each snapshot arrival.
 */
export function RemotePresenceLayer({
  presenceState,
  currentUserId,
  viewportRef,
  shapesRef,
  isDark,
}: RemotePresenceLayerProps) {
  // Structural state: which user IDs have visible overlays.
  // Only updated ~4×/sec from the slow poll — drives React re-renders.
  const [activeUserIds, setActiveUserIds] = useState<string[]>([]);

  // ── Refs used by RAF loop (no re-renders on change) ────────────────────
  const lastActiveByUserRef = useRef<Record<string, number>>({});
  const prevTargetBoundsRef = useRef<Record<string, SelectionBounds | null>>(
    {},
  );
  /** userId → rendered overlay div (for direct style writes). */
  const overlayElemsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const rafRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);

  // Remote presences (excludes self), stable via useMemo.
  const remotePresences: PresenceRender[] = useMemo(
    () =>
      (presenceState?.presences ?? [])
        .filter((p) => p.userId !== currentUserId)
        .map((p) => ({ ...p, color: getColor(p.userId) })),
    [presenceState, currentUserId],
  );

  // Refs so the RAF loop reads latest values without restarting.
  const remotePresencesRef = useRef(remotePresences);
  useEffect(() => {
    remotePresencesRef.current = remotePresences;
  }, [remotePresences]);
  // ── RAF loop: pure DOM mutation, zero setState ──────────────────────
  useEffect(() => {
    const tick = (timestamp: number) => {
      lastFrameTimeRef.current = timestamp;

      const vp = viewportRef.current;
      const presences = remotePresencesRef.current;

      if (vp && presences.length > 0) {
        const shapes = shapesRef.current ?? [];
        const shapeById = new Map<string, Shape>();
        for (const s of shapes) shapeById.set(s.id, s);

        const now = Date.now();

        for (const presence of presences) {
          const { userId, selectedIds } = presence;

          // ── Compute target bounds from latest shapes ──────────
          const targetBounds = getSelectionBounds(shapeById, selectedIds);
          const prevTarget = prevTargetBoundsRef.current[userId] ?? null;

          // Track activity.
          const isActing =
            selectedIds.length > 0 ||
            (presence.tool !== null && presence.tool !== "select");
          if (isActing || boundsChanged(prevTarget, targetBounds)) {
            lastActiveByUserRef.current[userId] = now;
          }
          prevTargetBoundsRef.current[userId] = targetBounds;

          const el = overlayElemsRef.current.get(userId);
          if (!el) continue;

          if (!targetBounds || selectedIds.length === 0) {
            el.style.transform = "translate3d(-9999px,-9999px,0)";
            el.style.visibility = "hidden";
            continue;
          }

          // ── Snap directly to shape position (no lerp) ────────
          // The box must track the shape with zero additional lag.
          // Smoothness comes from high-frequency burst snapshots.
          const left = targetBounds.x1 * vp.scale + vp.x;
          const top = targetBounds.y1 * vp.scale + vp.y;
          const w = (targetBounds.x2 - targetBounds.x1) * vp.scale;
          const h = (targetBounds.y2 - targetBounds.y1) * vp.scale;

          el.style.transform = `translate3d(${left}px,${top}px,0)`;
          el.style.width = `${w}px`;
          el.style.height = `${h}px`;
          el.style.visibility = "visible";
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [shapesRef, viewportRef]);

  // ── Slow poll: update the set of shown overlays (~4×/sec) ────────────
  useEffect(() => {
    const checkActive = () => {
      const now = Date.now();
      const presences = remotePresencesRef.current;

      const nextIds = presences
        .filter((p) => {
          const lastActive = lastActiveByUserRef.current[p.userId] ?? 0;
          const isActing =
            p.selectedIds.length > 0 ||
            (p.tool !== null && p.tool !== "select");
          return isActing || now - lastActive <= ACTIVE_WINDOW_MS;
        })
        .map((p) => p.userId);

      setActiveUserIds((prev) => {
        const prevSet = new Set(prev);
        const changed =
          prev.length !== nextIds.length ||
          nextIds.some((id) => !prevSet.has(id));
        return changed ? nextIds : prev;
      });
    };

    checkActive();
    const timer = window.setInterval(checkActive, 250);
    return () => window.clearInterval(timer);
  }, []);

  // Immediately refresh active set when presences change.
  useEffect(() => {
    const now = Date.now();
    for (const p of remotePresences) {
      const isActing =
        p.selectedIds.length > 0 || (p.tool !== null && p.tool !== "select");
      if (isActing) lastActiveByUserRef.current[p.userId] = now;
    }

    const nextIds = remotePresences
      .filter((p) => {
        const lastActive = lastActiveByUserRef.current[p.userId] ?? 0;
        const isActing =
          p.selectedIds.length > 0 || (p.tool !== null && p.tool !== "select");
        return isActing || now - lastActive <= ACTIVE_WINDOW_MS;
      })
      .map((p) => p.userId);

    setActiveUserIds((previous) =>
      areStringArraysEqual(previous, nextIds) ? previous : nextIds,
    );
  }, [remotePresences]);

  const canRender =
    Boolean(viewportRef.current) &&
    (presenceState?.connectedUsersCount ?? 0) > 1;
  if (!canRender) return null;

  const presenceByUserId = new Map(remotePresences.map((p) => [p.userId, p]));

  const floatingIds = activeUserIds.filter((id) => {
    const p = presenceByUserId.get(id);
    return p && p.selectedIds.length === 0;
  });

  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      {activeUserIds.map((userId) => {
        const presence = presenceByUserId.get(userId);
        if (!presence) return null;
        return (
          <div
            key={userId}
            ref={(el) => {
              if (el) overlayElemsRef.current.set(userId, el as HTMLDivElement);
              else overlayElemsRef.current.delete(userId);
            }}
            className={`absolute rounded-md border-2 ${isDark ? "bg-transparent" : "bg-white/5"}`}
            style={{
              transform: "translate3d(-9999px,-9999px,0)",
              top: 0,
              left: 0,
              width: 0,
              height: 0,
              willChange: "transform, width, height",
              visibility: "hidden",
              borderColor: presence.color,
              boxShadow: `0 0 0 1px ${presence.color}22, 0 0 18px ${presence.color}33`,
            }}
          >
            <div
              className="absolute -top-3 right-2 rounded-full px-2 py-0.5 text-[10px] font-semibold text-white shadow-lg"
              style={{ backgroundColor: presence.color }}
            >
              {presence.userName}
            </div>
          </div>
        );
      })}

      {floatingIds.length > 0 && (
        <div className="absolute right-4 top-16 flex flex-col gap-2">
          {floatingIds.map((userId) => {
            const presence = presenceByUserId.get(userId);
            if (!presence) return null;
            return (
              <div
                key={`floating-${userId}`}
                className="rounded-full px-2 py-1 text-[10px] font-semibold text-white shadow-lg"
                style={{ backgroundColor: presence.color }}
              >
                {presence.userName}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
