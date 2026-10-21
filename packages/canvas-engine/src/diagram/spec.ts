/*
spec.ts

Structured diagram specs. The AI describes *what* a diagram contains (nodes,
connections, colour roles) and this module decides *where* everything goes using
the layered layout, so connectors are always bound, labels sit inside their boxes
and nothing overlaps. Pure data in, shapes out: safe to run in a worker.
*/

import type { Shape } from "../types";
import {
  buildShapesFromDiagram,
  type DiagramTone,
  type MermaidDiagram,
  type MermaidNodeKind,
} from "./mermaid";

export type DiagramSpec = {
  title?: string;
  direction?: "TD" | "LR";
  nodes: Array<{
    id: string;
    label: string;
    kind?: MermaidNodeKind;
    tone?: DiagramTone;
  }>;
  edges: Array<{ from: string; to: string; label?: string; dashed?: boolean }>;
};

const TONES = new Set<DiagramTone>(["blue", "green", "amber", "violet", "red", "sky", "slate"]);
const KINDS = new Set<MermaidNodeKind>(["rect", "circle", "rhombus"]);
const MAX_NODES = 48;
const MAX_LABEL = 60;

/** Coerces untrusted model output into a spec, dropping anything unusable. */
export function normalizeDiagramSpec(raw: unknown): DiagramSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];

  const seen = new Set<string>();
  const nodes: DiagramSpec["nodes"] = [];
  for (const candidate of rawNodes) {
    if (nodes.length >= MAX_NODES) break;
    if (!candidate || typeof candidate !== "object") continue;
    const node = candidate as Record<string, unknown>;
    const id = typeof node.id === "string" ? node.id.trim() : "";
    const label = typeof node.label === "string" ? node.label.replace(/\s+/g, " ").trim() : "";
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    nodes.push({
      id,
      label: label.slice(0, MAX_LABEL),
      kind: KINDS.has(node.kind as MermaidNodeKind) ? (node.kind as MermaidNodeKind) : "rect",
      tone: TONES.has(node.tone as DiagramTone) ? (node.tone as DiagramTone) : undefined,
    });
  }

  const edges: DiagramSpec["edges"] = [];
  const rawEdges = Array.isArray(input.edges) ? input.edges : [];
  const edgeKeys = new Set<string>();
  for (const candidate of rawEdges) {
    if (!candidate || typeof candidate !== "object") continue;
    const edge = candidate as Record<string, unknown>;
    const from = typeof edge.from === "string" ? edge.from.trim() : "";
    const to = typeof edge.to === "string" ? edge.to.trim() : "";
    if (!seen.has(from) || !seen.has(to) || from === to) continue;
    const key = `${from}>${to}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    const label = typeof edge.label === "string" ? edge.label.replace(/\s+/g, " ").trim() : "";
    edges.push({
      from,
      to,
      ...(label ? { label: label.slice(0, 32) } : {}),
      ...(edge.dashed === true ? { dashed: true } : {}),
    });
  }

  if (nodes.length < 2) return null;
  return {
    title: typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 80) : undefined,
    direction: input.direction === "LR" ? "LR" : "TD",
    nodes,
    edges,
  };
}

/** Lays out a spec around `center` and returns ready-to-add shapes (title first). */
export function buildDiagramFromSpec(
  spec: DiagramSpec,
  options: { center: { x: number; y: number }; createId?: () => string },
): Shape[] {
  const diagram: MermaidDiagram = {
    direction: spec.direction ?? "TD",
    nodes: spec.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      kind: node.kind ?? "rect",
      tone: node.tone,
    })),
    edges: spec.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      label: edge.label,
      style: edge.dashed ? ("dashed" as const) : ("solid" as const),
      arrow: true,
    })),
  };

  const createId = options.createId ?? (() => crypto.randomUUID());
  const shapes = buildShapesFromDiagram(diagram, { center: options.center, createId, clean: true });
  if (!spec.title) return shapes;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  for (const shape of shapes) {
    if (shape.type === "rect" || shape.type === "rhombus" || shape.type === "text") {
      minX = Math.min(minX, shape.x);
      minY = Math.min(minY, shape.y);
      maxX = Math.max(maxX, shape.x + shape.width);
    } else if (shape.type === "circle") {
      minX = Math.min(minX, shape.centerX - shape.radiusX);
      minY = Math.min(minY, shape.centerY - shape.radiusY);
      maxX = Math.max(maxX, shape.centerX + shape.radiusX);
    }
  }
  const width = Math.min(Math.max(160, spec.title.length * 15), Math.max(160, maxX - minX));
  const title: Shape = {
    id: createId(),
    type: "text",
    x: minX,
    y: minY - 84,
    width,
    height: 36,
    text: spec.title,
    fontSize: 28,
    stroke: "#2a2820",
    roughness: 0,
    strokeStyle: "solid",
  };
  return [title, ...shapes];
}
