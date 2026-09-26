/*
tidy.ts

"Tidy layout": re-arranges the connected nodes of a diagram with the layered
layout, moving their bound labels and re-attaching connectors.
*/

import { convertToPoints } from "../geometry";
import type { Shape } from "../types";
import { connectorAnchors, layoutLayered, type LayoutDirection } from "./layout";

type NodeShape = Extract<Shape, { type: "rect" | "circle" | "rhombus" }>;

function isNode(shape: Shape): shape is NodeShape {
  return shape.type === "rect" || shape.type === "circle" || shape.type === "rhombus";
}

export function translateShape(shape: Shape, dx: number, dy: number): Shape {
  switch (shape.type) {
    case "rect":
    case "rhombus":
    case "text":
      return { ...shape, x: shape.x + dx, y: shape.y + dy };
    case "circle":
      return { ...shape, centerX: shape.centerX + dx, centerY: shape.centerY + dy };
    case "line":
    case "arrow":
      return {
        ...shape,
        x1: shape.x1 + dx,
        y1: shape.y1 + dy,
        x2: shape.x2 + dx,
        y2: shape.y2 + dy,
      };
    case "freehand":
      return {
        ...shape,
        points: shape.points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy })),
      };
  }
}

/**
 * Lays out the given shapes (nodes + their labels + connectors) and returns a
 * new array for the same ids. Shapes without any connector are left untouched
 * unless `includeUnconnected` is set. Returns null when there is nothing to lay out.
 */
export function tidyLayout(
  shapes: Shape[],
  direction: LayoutDirection,
): Shape[] | null {
  const allNodes = shapes.filter(isNode);
  if (allNodes.length < 2) return null;

  const nodeIds = new Set(allNodes.map((node) => node.id));
  const edges = shapes.flatMap((shape) =>
    (shape.type === "arrow" || shape.type === "line") &&
    shape.startBinding &&
    shape.endBinding &&
    nodeIds.has(shape.startBinding.shapeId) &&
    nodeIds.has(shape.endBinding.shapeId)
      ? [{ from: shape.startBinding.shapeId, to: shape.endBinding.shapeId }]
      : [],
  );
  if (edges.length === 0) return null;

  // Shapes with no connector stay exactly where they are.
  const connected = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  const nodes = allNodes.filter((node) => connected.has(node.id));

  const boxes = new Map(nodes.map((node) => [node.id, convertToPoints(node)]));
  const positions = layoutLayered(
    nodes.map((node) => {
      const box = boxes.get(node.id)!;
      return { id: node.id, width: box.x2 - box.x1, height: box.y2 - box.y1 };
    }),
    edges,
    direction,
  );

  // Keep the diagram anchored where it was: match the old top-left corner.
  let oldMinX = Infinity;
  let oldMinY = Infinity;
  for (const box of boxes.values()) {
    oldMinX = Math.min(oldMinX, box.x1);
    oldMinY = Math.min(oldMinY, box.y1);
  }
  let newMinX = Infinity;
  let newMinY = Infinity;
  for (const position of positions) {
    newMinX = Math.min(newMinX, position.x);
    newMinY = Math.min(newMinY, position.y);
  }

  const delta = new Map<string, { dx: number; dy: number }>();
  for (const position of positions) {
    const box = boxes.get(position.id)!;
    delta.set(position.id, {
      dx: position.x - newMinX + oldMinX - box.x1,
      dy: position.y - newMinY + oldMinY - box.y1,
    });
  }

  const moved = shapes.map((shape): Shape => {
    if (isNode(shape)) {
      const d = delta.get(shape.id);
      return d ? translateShape(shape, d.dx, d.dy) : shape;
    }
    if (shape.type === "text" && shape.parentId && delta.has(shape.parentId)) {
      const d = delta.get(shape.parentId)!;
      return translateShape(shape, d.dx, d.dy);
    }
    return shape;
  });

  // Re-attach connectors to the moved nodes using their normalized anchors.
  const byId = new Map(moved.map((shape) => [shape.id, shape]));
  const attach = (
    binding: { shapeId: string; relX: number; relY: number } | undefined,
    fallback: { x: number; y: number },
  ) => {
    const target = binding && byId.get(binding.shapeId);
    if (!binding || !target) return fallback;
    const box = convertToPoints(target);
    return {
      x: box.x1 + binding.relX * (box.x2 - box.x1),
      y: box.y1 + binding.relY * (box.y2 - box.y1),
    };
  };

  const rankOf = new Map(positions.map((position) => [position.id, position.rank]));
  const rerouted = moved.map((shape): Shape => {
    if (shape.type !== "arrow" && shape.type !== "line") return shape;

    // Re-anchor between the two nodes so the route suits the new direction.
    let startBinding = shape.startBinding;
    let endBinding = shape.endBinding;
    if (startBinding && endBinding) {
      const fromRank = rankOf.get(startBinding.shapeId);
      const toRank = rankOf.get(endBinding.shapeId);
      if (fromRank !== undefined && toRank !== undefined) {
        const { start, end } = connectorAnchors(
          direction,
          toRank > fromRank,
          toRank === fromRank,
        );
        startBinding = { ...startBinding, relX: start[0]!, relY: start[1]! };
        endBinding = { ...endBinding, relX: end[0]!, relY: end[1]! };
      }
    }

    const from = attach(startBinding, { x: shape.x1, y: shape.y1 });
    const to = attach(endBinding, { x: shape.x2, y: shape.y2 });
    return {
      ...shape,
      startBinding,
      endBinding,
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
    };
  });

  // Loose labels riding on a connector follow its new midpoint.
  const oldMid = new Map<string, { x: number; y: number }>();
  for (const shape of shapes) {
    if (shape.type === "arrow" || shape.type === "line") {
      oldMid.set(shape.id, { x: (shape.x1 + shape.x2) / 2, y: (shape.y1 + shape.y2) / 2 });
    }
  }
  const newConnectors = rerouted.filter(
    (shape): shape is Extract<Shape, { type: "arrow" | "line" }> =>
      shape.type === "arrow" || shape.type === "line",
  );

  return rerouted.map((shape): Shape => {
    if (shape.type !== "text" || shape.parentId) return shape;
    const box = convertToPoints(shape);
    const cx = (box.x1 + box.x2) / 2;
    const cy = (box.y1 + box.y2) / 2;
    for (const connector of newConnectors) {
      const previous = oldMid.get(connector.id);
      if (!previous) continue;
      if (Math.abs(previous.x - cx) <= 30 && Math.abs(previous.y - cy) <= 30) {
        return translateShape(
          shape,
          (connector.x1 + connector.x2) / 2 - previous.x,
          (connector.y1 + connector.y2) / 2 - previous.y,
        );
      }
    }
    return shape;
  });
}
