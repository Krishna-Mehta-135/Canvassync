/*
labels.ts

Links free-floating text to the box it sits in, so the text follows when that
box is moved, resized or aligned. AI-generated and image-imported diagrams
place labels as separate, unlinked text shapes; this repairs them.
*/

import { convertToPoints } from "../geometry";
import type { Shape } from "../types";

type Container = Extract<Shape, { type: "rect" | "circle" | "rhombus" }>;

const MIN_OVERLAP = 0.6;

function isContainer(shape: Shape): shape is Container {
  return shape.type === "rect" || shape.type === "circle" || shape.type === "rhombus";
}

/**
 * Sets `parentId` on unlinked text whose box is (mostly) inside exactly one
 * container — the smallest one that fits. `onlyIds` limits which texts change.
 * Returns the new array and how many labels were linked.
 */
export function bindTextToContainers(
  shapes: Shape[],
  onlyIds?: ReadonlySet<string>,
): { shapes: Shape[]; linked: number } {
  const containers = shapes
    .filter(isContainer)
    .map((shape) => ({ shape, box: convertToPoints(shape) }))
    .map((item) => ({
      ...item,
      area: Math.max(1, (item.box.x2 - item.box.x1) * (item.box.y2 - item.box.y1)),
    }));

  let linked = 0;
  const next = shapes.map((shape): Shape => {
    if (shape.type !== "text" || shape.parentId) return shape;
    if (onlyIds && !onlyIds.has(shape.id)) return shape;

    const text = convertToPoints(shape);
    const textArea = Math.max(1, (text.x2 - text.x1) * (text.y2 - text.y1));
    const cx = (text.x1 + text.x2) / 2;
    const cy = (text.y1 + text.y2) / 2;

    let best: (typeof containers)[number] | null = null;
    for (const container of containers) {
      const { box } = container;
      if (cx < box.x1 || cx > box.x2 || cy < box.y1 || cy > box.y2) continue;

      const overlapW = Math.min(text.x2, box.x2) - Math.max(text.x1, box.x1);
      const overlapH = Math.min(text.y2, box.y2) - Math.max(text.y1, box.y1);
      if (overlapW <= 0 || overlapH <= 0) continue;
      if ((overlapW * overlapH) / textArea < MIN_OVERLAP) continue;

      if (!best || container.area < best.area) best = container;
    }

    if (!best) return shape;
    linked += 1;
    return { ...shape, parentId: best.shape.id };
  });

  return { shapes: next, linked };
}

const ATTACH_DISTANCE = 24;

/**
 * Binds loose connector endpoints that touch a box edge (within a few px) to
 * that box, so lines follow when boxes move. Endpoints keep their exact
 * position (relX/relY are derived from where they are on the edge).
 */
export function bindConnectorsToContainers(
  shapes: Shape[],
  onlyIds?: ReadonlySet<string>,
): { shapes: Shape[]; bound: number } {
  const containers = shapes.filter(isContainer).map((shape) => ({
    shape,
    box: convertToPoints(shape),
  }));

  const attach = (x: number, y: number) => {
    let best: { shapeId: string; relX: number; relY: number; dist: number } | null = null;
    for (const { shape, box } of containers) {
      const w = box.x2 - box.x1;
      const h = box.y2 - box.y1;
      if (w <= 0 || h <= 0) continue;
      const dx = Math.max(box.x1 - x, 0, x - box.x2);
      const dy = Math.max(box.y1 - y, 0, y - box.y2);
      let dist = Math.hypot(dx, dy);
      if (dist === 0) {
        // Inside the box: distance to the nearest edge.
        dist = Math.min(x - box.x1, box.x2 - x, y - box.y1, box.y2 - y);
      }
      if (dist > ATTACH_DISTANCE) continue;
      if (best && dist >= best.dist) continue;
      best = {
        shapeId: shape.id,
        relX: Math.min(1, Math.max(0, (x - box.x1) / w)),
        relY: Math.min(1, Math.max(0, (y - box.y1) / h)),
        dist,
      };
    }
    return best;
  };

  let bound = 0;
  const next = shapes.map((shape): Shape => {
    if (shape.type !== "arrow" && shape.type !== "line") return shape;
    if (onlyIds && !onlyIds.has(shape.id)) return shape;

    const start = shape.startBinding ? null : attach(shape.x1, shape.y1);
    const end = shape.endBinding ? null : attach(shape.x2, shape.y2);
    // Never glue both ends to the same box.
    if (start && end && start.shapeId === end.shapeId) return shape;
    if (!start && !end) return shape;

    bound += (start ? 1 : 0) + (end ? 1 : 0);
    return {
      ...shape,
      ...(start
        ? { startBinding: { shapeId: start.shapeId, relX: start.relX, relY: start.relY } }
        : {}),
      ...(end
        ? { endBinding: { shapeId: end.shapeId, relX: end.relX, relY: end.relY } }
        : {}),
    };
  });

  return { shapes: next, bound };
}
