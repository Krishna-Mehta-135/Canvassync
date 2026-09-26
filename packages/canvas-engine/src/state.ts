/*
CanvasState

Stores shapes AND their history.

We keep:
- past    → previous states (for undo)
- present → current state
- future  → undone states (for redo)

IMPORTANT:
- Each state is a full snapshot (Shape[])
- No mutation allowed outside this class
*/

import { Shape } from "./types";

// File intent: canonicalize shape geometry on all state writes so hit testing and selection stay consistent.

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeRectLike<
  T extends { x: number; y: number; width: number; height: number },
>(shape: T, minSpan = 1): T {
  const x = finiteOr(shape.x, 0);
  const y = finiteOr(shape.y, 0);
  const width = finiteOr(shape.width, minSpan);
  const height = finiteOr(shape.height, minSpan);
  const x2 = x + width;
  const y2 = y + height;

  return {
    ...shape,
    x: Math.min(x, x2),
    y: Math.min(y, y2),
    width: Math.max(minSpan, Math.abs(x2 - x)),
    height: Math.max(minSpan, Math.abs(y2 - y)),
  };
}

function normalizeShapes(shapes: Shape[]): Shape[] {
  const normalized = shapes.map((shape) => {
    if (shape.type === "rect" || shape.type === "rhombus") {
      return normalizeRectLike(shape, 1);
    }

    if (shape.type === "circle") {
      return {
        ...shape,
        centerX: finiteOr(shape.centerX, 0),
        centerY: finiteOr(shape.centerY, 0),
        radiusX: Math.max(1, Math.abs(finiteOr(shape.radiusX, 1))),
        radiusY: Math.max(1, Math.abs(finiteOr(shape.radiusY, 1))),
      };
    }

    if (shape.type === "line" || shape.type === "arrow") {
      const x1 = finiteOr(shape.x1, 0);
      const y1 = finiteOr(shape.y1, 0);
      const x2Raw = finiteOr(shape.x2, x1 + 1);
      const y2 = finiteOr(shape.y2, y1);
      const x2 = x1 === x2Raw && y1 === y2 ? x2Raw + 1 : x2Raw;

      return {
        ...shape,
        x1,
        y1,
        x2,
        y2,
      };
    }

    if (shape.type === "text") {
      return normalizeRectLike(
        {
          ...shape,
          x: finiteOr(shape.x, 0),
          y: finiteOr(shape.y, 0),
          width: finiteOr(shape.width, 24),
          height: finiteOr(shape.height, 16),
          fontSize: Math.max(8, finiteOr(shape.fontSize, 16)),
          text: typeof shape.text === "string" ? shape.text : "",
        },
        8,
      );
    }

    if (shape.type === "freehand") {
      const points = shape.points
        .map((point) => {
          const x = finiteOr(point.x, NaN);
          const y = finiteOr(point.y, NaN);
          if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
          const t =
            point.t !== undefined
              ? finiteOr(point.t, undefined as unknown as number)
              : undefined;
          return t !== undefined && Number.isFinite(t) ? { x, y, t } : { x, y };
        })
        .filter(
          (point): point is { x: number; y: number; t?: number } =>
            point !== null,
        );

      return {
        ...shape,
        points,
      };
    }

    return shape;
  });

  const knownIds = new Set(normalized.map((shape) => shape.id));
  return normalized.map((shape) => {
    if (shape.type !== "text") return shape;
    if (!shape.parentId) return shape;
    if (knownIds.has(shape.parentId)) return shape;
    return {
      ...shape,
      parentId: undefined,
    };
  });
}

export class CanvasState {
  private past: Shape[][] = [];
  private present: Shape[] = [];
  private future: Shape[][] = [];
  /**
   * Pub-sub listeners.
   *
   * Important:
   * - Shapes are NOT subscribers.
   * - A listener is a callback function owned by outside code (e.g. app layer).
   * - We pass Shape[] to listeners as event payload data.
   */
  private listeners = new Set<(shapes: Shape[]) => void>();

  // Read-only states ignore local edits (setShapes/undo/redo); hydrateShapes
  // still applies remote updates.
  private readOnly = false;

  setReadOnly(value: boolean) {
    this.readOnly = value;
  }

  isReadOnly() {
    return this.readOnly;
  }

  private notifyChange() {
    for (const listener of this.listeners) {
      listener([...this.present]);
    }
  }

  getShapes() {
    return this.present;
  }

  /**
   * Apply a new state.
   * - push current → past
   * - replace present
   * - clear future (redo invalidated)
   */
  setShapes(newShapes: Shape[]) {
    if (this.readOnly) return;
    this.past.push(this.present);
    this.present = normalizeShapes(newShapes);
    this.future = [];
    this.notifyChange();
  }

  /**
   * Hydrate state from persistence without affecting undo/redo history.
   */
  hydrateShapes(shapes: Shape[]) {
    this.past = [];
    this.present = normalizeShapes(shapes);
    this.future = [];
    this.notifyChange();
  }

  /**
   * Undo:
   * move one step back in history
   */
  undo() {
    if (this.readOnly || this.past.length === 0) return;

    const prev = this.past.pop()!;
    this.future.push(this.present);
    this.present = prev;
    this.notifyChange();
  }

  /**
   * Redo:
   * move one step forward
   */
  redo() {
    if (this.readOnly || this.future.length === 0) return;

    const next = this.future.pop()!;
    this.past.push(this.present);
    this.present = next;
    this.notifyChange();
  }

  /**
   * Subscribe to state changes.
   *
   * Returns an unsubscribe function to stop receiving updates.
   * Call this on component cleanup to avoid duplicate listeners/memory leaks.
   */
  subscribe(listener: (shapes: Shape[]) => void) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }
}
