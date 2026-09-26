/*
layout.ts

Small layered (Sugiyama-style) graph layout used by Mermaid import and the
"tidy layout" action. Pure geometry: no canvas or shape knowledge.

Steps: break cycles → longest-path ranking → barycenter ordering → coordinate
assignment. Good enough for flowcharts/architecture diagrams of a few dozen nodes.
*/

export type LayoutDirection = "TD" | "LR";

export type LayoutNode = { id: string; width: number; height: number };
export type LayoutEdge = { from: string; to: string };
export type LayoutPosition = { id: string; x: number; y: number; rank: number };

const LAYER_GAP = 100;
const NODE_GAP = 56;
const ORDERING_SWEEPS = 4;

export function layoutLayered(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  direction: LayoutDirection,
): LayoutPosition[] {
  if (nodes.length === 0) return [];

  const ids = nodes.map((node) => node.id);
  const known = new Set(ids);
  const size = new Map(nodes.map((node) => [node.id, node]));

  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    if (edge.from === edge.to) continue;
    out.get(edge.from)!.push(edge.to);
  }

  // 1. Cycle removal: DFS, dropping edges that point back into the active path.
  const dagOut = new Map<string, string[]>(ids.map((id) => [id, []]));
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const next of out.get(id)!) {
      const nextState = state.get(next) ?? 0;
      if (nextState === 1) continue; // back edge
      dagOut.get(id)!.push(next);
      if (nextState === 0) visit(next);
    }
    state.set(id, 2);
  };
  for (const id of ids) {
    if (!state.has(id)) visit(id);
  }

  // 2. Longest-path ranking over the DAG (Kahn order).
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const targets of dagOut.values()) {
    for (const target of targets) {
      indegree.set(target, (indegree.get(target) ?? 0) + 1);
    }
  }
  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => indegree.get(id) === 0);
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const target of dagOut.get(id)!) {
      rank.set(target, Math.max(rank.get(target)!, rank.get(id)! + 1));
      const remaining = indegree.get(target)! - 1;
      indegree.set(target, remaining);
      if (remaining === 0) queue.push(target);
    }
  }

  const layers: string[][] = [];
  for (const id of ids) {
    const r = rank.get(id)!;
    (layers[r] ??= []).push(id);
  }
  for (let i = 0; i < layers.length; i += 1) layers[i] ??= [];

  // 3. Barycenter ordering to reduce crossings.
  const inbound = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [from, targets] of dagOut) {
    for (const to of targets) inbound.get(to)!.push(from);
  }
  const order = new Map<string, number>();
  const reindex = () => {
    for (const layer of layers) layer.forEach((id, index) => order.set(id, index));
  };
  reindex();

  const sortLayer = (layer: string[], neighbours: Map<string, string[]>) => {
    const score = new Map<string, number>();
    for (const id of layer) {
      const linked = neighbours.get(id)!;
      score.set(
        id,
        linked.length === 0
          ? order.get(id)!
          : linked.reduce((sum, other) => sum + order.get(other)!, 0) /
              linked.length,
      );
    }
    layer.sort((a, b) => score.get(a)! - score.get(b)! || order.get(a)! - order.get(b)!);
  };

  for (let sweep = 0; sweep < ORDERING_SWEEPS; sweep += 1) {
    for (let r = 1; r < layers.length; r += 1) {
      sortLayer(layers[r]!, inbound);
      reindex();
    }
    for (let r = layers.length - 2; r >= 0; r -= 1) {
      sortLayer(layers[r]!, dagOut);
      reindex();
    }
  }

  // 4. Coordinates. "breadth" runs across a layer, "depth" between layers.
  const breadthOf = (id: string) =>
    direction === "TD" ? size.get(id)!.width : size.get(id)!.height;
  const depthOf = (id: string) =>
    direction === "TD" ? size.get(id)!.height : size.get(id)!.width;

  const positions: LayoutPosition[] = [];
  let depthCursor = 0;
  layers.forEach((layer, layerIndex) => {
    if (layer.length === 0) return;
    const total =
      layer.reduce((sum, id) => sum + breadthOf(id), 0) +
      NODE_GAP * (layer.length - 1);
    const layerDepth = Math.max(...layer.map(depthOf));

    let breadthCursor = -total / 2;
    for (const id of layer) {
      const breadth = breadthCursor;
      const depth = depthCursor + (layerDepth - depthOf(id)) / 2;
      positions.push({
        id,
        x: direction === "TD" ? breadth : depth,
        y: direction === "TD" ? depth : breadth,
        rank: layerIndex,
      });
      breadthCursor += breadthOf(id) + NODE_GAP;
    }
    depthCursor += layerDepth + LAYER_GAP;
  });

  return positions;
}

/** Where a connector attaches on a node, in normalized bbox space. */
export function connectorAnchors(direction: LayoutDirection, forward: boolean, sameRank: boolean) {
  if (sameRank) {
    return direction === "TD"
      ? { start: [1, 0.5], end: [0, 0.5] }
      : { start: [0.5, 1], end: [0.5, 0] };
  }
  if (direction === "TD") {
    return forward
      ? { start: [0.5, 1], end: [0.5, 0] }
      : { start: [0.5, 0], end: [0.5, 1] };
  }
  return forward
    ? { start: [1, 0.5], end: [0, 0.5] }
    : { start: [0, 0.5], end: [1, 0.5] };
}
