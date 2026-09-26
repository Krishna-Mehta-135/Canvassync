/*
arrange.ts

Align and distribute a multi-selection. Bound labels travel with their parent
shape and connectors attached to moved shapes are re-anchored.
*/

import { convertToPoints } from "../geometry";
import type { Shape } from "../types";
import { reattachConnectors, translateShape } from "./tidy";

export type AlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";
export type DistributeAxis = "horizontal" | "vertical";

type Item = { shape: Shape; x1: number; y1: number; x2: number; y2: number };

/** Top-level movable items: not connectors, and not labels riding on a selected parent. */
function collectItems(shapes: Shape[], ids: ReadonlySet<string>): Item[] {
  return shapes
    .filter((shape) => {
      if (!ids.has(shape.id)) return false;
      if (shape.type === "arrow" || shape.type === "line") return false;
      if (shape.type === "text" && shape.parentId && ids.has(shape.parentId)) return false;
      return true;
    })
    .map((shape) => ({ shape, ...convertToPoints(shape) }));
}

function applyMoves(
  shapes: Shape[],
  moves: Map<string, { dx: number; dy: number }>,
): Shape[] {
  const moved = shapes.map((shape): Shape => {
    const own = moves.get(shape.id);
    if (own) return translateShape(shape, own.dx, own.dy);
    if (shape.type === "text" && shape.parentId) {
      const parent = moves.get(shape.parentId);
      if (parent) return translateShape(shape, parent.dx, parent.dy);
    }
    return shape;
  });
  return reattachConnectors(moved, new Set(moves.keys()));
}

export function alignShapes(
  shapes: Shape[],
  ids: ReadonlySet<string>,
  mode: AlignMode,
): Shape[] | null {
  const items = collectItems(shapes, ids);
  if (items.length < 2) return null;

  const minX = Math.min(...items.map((i) => i.x1));
  const maxX = Math.max(...items.map((i) => i.x2));
  const minY = Math.min(...items.map((i) => i.y1));
  const maxY = Math.max(...items.map((i) => i.y2));

  const moves = new Map<string, { dx: number; dy: number }>();
  for (const item of items) {
    let dx = 0;
    let dy = 0;
    if (mode === "left") dx = minX - item.x1;
    else if (mode === "right") dx = maxX - item.x2;
    else if (mode === "hcenter") dx = (minX + maxX) / 2 - (item.x1 + item.x2) / 2;
    else if (mode === "top") dy = minY - item.y1;
    else if (mode === "bottom") dy = maxY - item.y2;
    else dy = (minY + maxY) / 2 - (item.y1 + item.y2) / 2;
    if (dx !== 0 || dy !== 0) moves.set(item.shape.id, { dx, dy });
  }
  return moves.size === 0 ? null : applyMoves(shapes, moves);
}

/** Even gaps between shapes along an axis; the outermost two stay in place. */
export function distributeShapes(
  shapes: Shape[],
  ids: ReadonlySet<string>,
  axis: DistributeAxis,
): Shape[] | null {
  const items = collectItems(shapes, ids);
  if (items.length < 3) return null;

  const horizontal = axis === "horizontal";
  const start = (item: Item) => (horizontal ? item.x1 : item.y1);
  const end = (item: Item) => (horizontal ? item.x2 : item.y2);
  const sorted = [...items].sort((a, b) => start(a) - start(b));

  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const totalSize = sorted.reduce((sum, item) => sum + (end(item) - start(item)), 0);
  const gap = (end(last) - start(first) - totalSize) / (sorted.length - 1);

  const moves = new Map<string, { dx: number; dy: number }>();
  let cursor = start(first);
  for (const item of sorted) {
    const delta = cursor - start(item);
    if (delta !== 0) {
      moves.set(item.shape.id, horizontal ? { dx: delta, dy: 0 } : { dx: 0, dy: delta });
    }
    cursor += end(item) - start(item) + gap;
  }
  return moves.size === 0 ? null : applyMoves(shapes, moves);
}
