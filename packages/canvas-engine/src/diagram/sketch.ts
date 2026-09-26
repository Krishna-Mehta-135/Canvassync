/*
sketch.ts

Recognizes rough freehand strokes and replaces them with clean shapes:
closed strokes become rect / ellipse / rhombus, straight strokes become lines,
and strokes that start/end on shapes become bound arrows.

Pure geometry — no rendering. Errors are measured against each candidate shape
in normalized bbox space and the best fit under a tolerance wins.
*/

import { convertToPoints } from "../geometry";
import type { Shape } from "../types";

type Point = { x: number; y: number };
type FreehandShape = Extract<Shape, { type: "freehand" }>;

export type StrokeRecognition =
  | { kind: "rect" | "rhombus" | "circle"; x1: number; y1: number; x2: number; y2: number }
  | { kind: "line"; start: Point; end: Point };

const MIN_POINTS = 8;
const MIN_SIZE = 24;
const CLOSED_GAP_RATIO = 0.18;
const LINE_DEVIATION_RATIO = 0.07;
const ATTACH_DISTANCE = 32;

const TOLERANCE = { rect: 0.07, rhombus: 0.1, circle: 0.13 } as const;

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pathLength(points: Point[]) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += distance(points[i - 1]!, points[i]!);
  return total;
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function recognizeStroke(points: Point[]): StrokeRecognition | null {
  if (points.length < MIN_POINTS) return null;

  const length = pathLength(points);
  if (length < MIN_SIZE) return null;

  const first = points[0]!;
  const last = points[points.length - 1]!;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const width = maxX - minX;
  const height = maxY - minY;

  const closed = distance(first, last) <= length * CLOSED_GAP_RATIO;

  if (!closed) {
    const chord = distance(first, last);
    if (chord < MIN_SIZE) return null;
    // Perpendicular distance of every point from the chord.
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    const maxDeviation = Math.max(
      ...points.map((point) => Math.abs((point.x - first.x) * dy - (point.y - first.y) * dx) / chord),
    );
    return maxDeviation <= chord * LINE_DEVIATION_RATIO
      ? { kind: "line", start: first, end: last }
      : null;
  }

  if (width < MIN_SIZE || height < MIN_SIZE) return null;

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = width / 2;
  const ry = height / 2;
  const scale = Math.max(width, height);

  const errors = {
    circle: mean(
      points.map((p) => Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1)),
    ),
    rhombus: mean(
      points.map((p) => Math.abs(Math.abs(p.x - cx) / rx + Math.abs(p.y - cy) / ry - 1)),
    ),
    rect: mean(
      points.map(
        (p) =>
          Math.min(
            Math.abs(p.x - minX),
            Math.abs(p.x - maxX),
            Math.abs(p.y - minY),
            Math.abs(p.y - maxY),
          ) / scale,
      ),
    ),
  };

  let best: keyof typeof errors | null = null;
  for (const kind of ["rect", "rhombus", "circle"] as const) {
    if (errors[kind] > TOLERANCE[kind]) continue;
    if (best === null || errors[kind] / TOLERANCE[kind] < errors[best] / TOLERANCE[best]) {
      best = kind;
    }
  }
  return best ? { kind: best, x1: minX, y1: minY, x2: maxX, y2: maxY } : null;
}

type NodeShape = Extract<Shape, { type: "rect" | "circle" | "rhombus" }>;

/** Finds the node whose bbox edge is near `point`, and the anchor on that edge. */
function findAttachment(point: Point, nodes: NodeShape[]) {
  let best: { shapeId: string; relX: number; relY: number; dist: number } | null = null;

  for (const node of nodes) {
    const box = convertToPoints(node);
    const w = box.x2 - box.x1;
    const h = box.y2 - box.y1;
    if (w <= 0 || h <= 0) continue;

    // Outside distance to the bbox (0 when inside), then snap to nearest side midpoint.
    const outsideX = Math.max(box.x1 - point.x, 0, point.x - box.x2);
    const outsideY = Math.max(box.y1 - point.y, 0, point.y - box.y2);
    const outside = Math.hypot(outsideX, outsideY);
    const sides = [
      { d: Math.abs(point.y - box.y1), relX: 0.5, relY: 0 },
      { d: Math.abs(point.y - box.y2), relX: 0.5, relY: 1 },
      { d: Math.abs(point.x - box.x1), relX: 0, relY: 0.5 },
      { d: Math.abs(point.x - box.x2), relX: 1, relY: 0.5 },
    ];
    const side = sides.reduce((a, b) => (b.d < a.d ? b : a));
    const dist = outside > 0 ? outside : side.d;
    if (dist > ATTACH_DISTANCE) continue;
    if (!best || dist < best.dist) {
      best = { shapeId: node.id, relX: side.relX, relY: side.relY, dist };
    }
  }
  return best;
}

export function snapSketches(
  shapes: Shape[],
  targetIds: ReadonlySet<string>,
  createId: () => string = () => crypto.randomUUID(),
): { shapes: Shape[]; recognized: number } {
  const nodes = shapes.filter(
    (shape): shape is NodeShape =>
      shape.type === "rect" || shape.type === "circle" || shape.type === "rhombus",
  );

  let recognized = 0;
  const next = shapes.map((shape): Shape => {
    if (shape.type !== "freehand" || !targetIds.has(shape.id)) return shape;
    const result = recognizeStroke((shape as FreehandShape).points);
    if (!result) return shape;

    const style = {
      stroke: shape.stroke,
      strokeStyle: shape.strokeStyle,
      strokeWidth: shape.strokeWidth,
      roughness: shape.roughness,
      opacity: shape.opacity,
    };
    recognized += 1;

    if (result.kind === "line") {
      const startAnchor = findAttachment(result.start, nodes);
      const endAnchor = findAttachment(result.end, nodes);
      const attached = Boolean(startAnchor || endAnchor);
      // Never bind both ends to the same node (a stray loop).
      const sameNode =
        startAnchor && endAnchor && startAnchor.shapeId === endAnchor.shapeId;

      const resolve = (
        point: Point,
        anchor: NonNullable<ReturnType<typeof findAttachment>> | null,
      ) => {
        if (!anchor || sameNode) return { point, binding: undefined };
        const node = nodes.find((n) => n.id === anchor.shapeId)!;
        const box = convertToPoints(node);
        return {
          point: {
            x: box.x1 + anchor.relX * (box.x2 - box.x1),
            y: box.y1 + anchor.relY * (box.y2 - box.y1),
          },
          binding: { shapeId: anchor.shapeId, relX: anchor.relX, relY: anchor.relY },
        };
      };

      const from = resolve(result.start, startAnchor);
      const to = resolve(result.end, endAnchor);
      return {
        ...style,
        id: createId(),
        type: attached && !sameNode ? "arrow" : "line",
        x1: from.point.x,
        y1: from.point.y,
        x2: to.point.x,
        y2: to.point.y,
        startBinding: from.binding,
        endBinding: to.binding,
      } as Shape;
    }

    if (result.kind === "circle") {
      return {
        ...style,
        id: createId(),
        type: "circle",
        centerX: (result.x1 + result.x2) / 2,
        centerY: (result.y1 + result.y2) / 2,
        radiusX: (result.x2 - result.x1) / 2,
        radiusY: (result.y2 - result.y1) / 2,
      } as Shape;
    }

    return {
      ...style,
      id: createId(),
      type: result.kind,
      x: result.x1,
      y: result.y1,
      width: result.x2 - result.x1,
      height: result.y2 - result.y1,
    } as Shape;
  });

  return { shapes: next, recognized };
}
