/*
mermaid.ts

Mermaid flowchart <-> canvas shapes.

Supports the commonly used subset: `flowchart|graph TD|TB|BT|LR|RL`, node
shapes [rect] (round) {decision} ((circle)) ([stadium]) [(db)] {{hex}},
links --> --- -.-> ==> with |labels| or -- labels -->, `&` fan-out and chains.
Unsupported statements (subgraph, style, classDef, click…) are skipped.
*/

import { convertToPoints } from "../geometry";
import type { Shape } from "../types";
import { connectorAnchors, layoutLayered, type LayoutDirection } from "./layout";

export type MermaidNodeKind = "rect" | "circle" | "rhombus";

export type MermaidNode = { id: string; label: string; kind: MermaidNodeKind };
export type MermaidEdge = {
  from: string;
  to: string;
  label?: string;
  style: "solid" | "dashed";
  arrow: boolean;
};
export type MermaidDiagram = {
  direction: LayoutDirection;
  nodes: MermaidNode[];
  edges: MermaidEdge[];
};

export class MermaidParseError extends Error {}

// ── Parsing ────────────────────────────────────────────────────────────────

const HEADER = /^(?:flowchart|graph)\s*(TD|TB|BT|LR|RL)?\s*$/i;
const SKIPPED_STATEMENT =
  /^(?:subgraph\b|end\b|classDef\b|class\b|style\b|linkStyle\b|click\b|direction\b|accTitle\b|accDescr\b)/i;

// Ordered so that longer openers win.
const SHAPES: Array<{ open: string; close: string; kind: MermaidNodeKind }> = [
  { open: "(((", close: ")))", kind: "circle" },
  { open: "((", close: "))", kind: "circle" },
  { open: "([", close: "])", kind: "rect" },
  { open: "[(", close: ")]", kind: "rect" },
  { open: "[[", close: "]]", kind: "rect" },
  { open: "{{", close: "}}", kind: "rhombus" },
  { open: "[/", close: "/]", kind: "rect" },
  { open: "[\\", close: "\\]", kind: "rect" },
  { open: "{", close: "}", kind: "rhombus" },
  { open: "[", close: "]", kind: "rect" },
  { open: "(", close: ")", kind: "rect" },
  { open: ">", close: "]", kind: "rect" },
];

const LINK_TEXT_FORMS = [
  /\s*--\s+([^>\n]+?)\s+(-->|---)/y,
  /\s*-\.\s+(.+?)\s+\.->/y,
  /\s*==\s+(.+?)\s+==>/y,
];
const LINK_SYMBOL =
  /\s*(<?)(-{2,}>|-{3,}|={2,}>|={3,}|-\.+->|-\.+-|--[xo])(?:\s*\|([^|]*)\|)?/y;

function cleanLabel(raw: string) {
  let text = raw.trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("`") && text.endsWith("`"))
  ) {
    text = text.slice(1, -1);
  }
  return text
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

type Cursor = { text: string; pos: number };

function skipSpaces(cursor: Cursor) {
  while (cursor.pos < cursor.text.length && /\s/.test(cursor.text[cursor.pos]!)) {
    cursor.pos += 1;
  }
}

function readNodeRef(cursor: Cursor): MermaidNode | null {
  skipSpaces(cursor);
  const idMatch = /[A-Za-z0-9_À-￿]+/y;
  idMatch.lastIndex = cursor.pos;
  const found = idMatch.exec(cursor.text);
  if (!found) return null;

  const id = found[0];
  cursor.pos += id.length;

  for (const shape of SHAPES) {
    if (!cursor.text.startsWith(shape.open, cursor.pos)) continue;
    const bodyStart = cursor.pos + shape.open.length;
    // Quoted labels may contain closing characters.
    let bodyEnd: number;
    if (cursor.text[bodyStart] === '"') {
      const closingQuote = cursor.text.indexOf('"', bodyStart + 1);
      if (closingQuote === -1) break;
      bodyEnd = cursor.text.indexOf(shape.close, closingQuote + 1);
    } else {
      bodyEnd = cursor.text.indexOf(shape.close, bodyStart);
    }
    if (bodyEnd === -1) break;

    const label = cleanLabel(cursor.text.slice(bodyStart, bodyEnd));
    cursor.pos = bodyEnd + shape.close.length;
    return { id, label: label || id, kind: shape.kind };
  }

  return { id, label: "", kind: "rect" };
}

function readNodeGroup(cursor: Cursor): MermaidNode[] | null {
  const group: MermaidNode[] = [];
  for (;;) {
    const node = readNodeRef(cursor);
    if (!node) return group.length > 0 ? group : null;
    group.push(node);
    skipSpaces(cursor);
    if (cursor.text[cursor.pos] === "&") {
      cursor.pos += 1;
      continue;
    }
    return group;
  }
}

function readLink(cursor: Cursor) {
  for (const form of LINK_TEXT_FORMS) {
    form.lastIndex = cursor.pos;
    const match = form.exec(cursor.text);
    if (match) {
      cursor.pos = form.lastIndex;
      const arrowText = match[2] ?? "";
      return {
        label: cleanLabel(match[1] ?? ""),
        dashed: form.source.startsWith("\\s*-\\."),
        arrow: arrowText === "" ? true : arrowText.endsWith(">"),
      };
    }
  }

  LINK_SYMBOL.lastIndex = cursor.pos;
  const match = LINK_SYMBOL.exec(cursor.text);
  if (!match) return null;
  cursor.pos = LINK_SYMBOL.lastIndex;
  const symbol = match[2] ?? "";
  return {
    label: cleanLabel(match[3] ?? ""),
    dashed: symbol.includes("."),
    arrow: symbol.endsWith(">") || symbol.endsWith("x") || symbol.endsWith("o"),
  };
}

export function parseMermaidFlowchart(source: string): MermaidDiagram {
  const lines = source
    .split(/\r?\n/)
    .flatMap((line) => line.split(";"))
    .map((line) => line.replace(/%%.*$/, "").trim())
    .filter(Boolean);

  const headerLine = lines.shift();
  const header = headerLine ? HEADER.exec(headerLine) : null;
  if (!header) {
    throw new MermaidParseError(
      'Start with "flowchart TD" (or "graph LR"). Only flowcharts are supported.',
    );
  }
  const rawDirection = (header[1] ?? "TD").toUpperCase();
  const direction: LayoutDirection =
    rawDirection === "LR" || rawDirection === "RL" ? "LR" : "TD";

  const nodes = new Map<string, MermaidNode>();
  const edges: MermaidEdge[] = [];

  const remember = (node: MermaidNode) => {
    const existing = nodes.get(node.id);
    if (!existing) {
      nodes.set(node.id, node);
    } else if (node.label) {
      // A later definition with a label/shape refines an earlier bare reference.
      nodes.set(node.id, { ...node });
    }
  };

  for (const line of lines) {
    if (SKIPPED_STATEMENT.test(line)) continue;

    const cursor: Cursor = { text: line, pos: 0 };
    let previous = readNodeGroup(cursor);
    if (!previous) continue;
    previous.forEach(remember);

    for (;;) {
      const link = readLink(cursor);
      if (!link) break;
      const next = readNodeGroup(cursor);
      if (!next) break;
      next.forEach(remember);
      for (const from of previous) {
        for (const to of next) {
          edges.push({
            from: from.id,
            to: to.id,
            label: link.label || undefined,
            style: link.dashed ? "dashed" : "solid",
            arrow: link.arrow,
          });
        }
      }
      previous = next;
    }
  }

  if (nodes.size === 0) {
    throw new MermaidParseError("No nodes found in the diagram.");
  }
  if (nodes.size > 150) {
    throw new MermaidParseError("Diagram is too large (max 150 nodes).");
  }

  return {
    direction,
    nodes: [...nodes.values()].map((node) => ({
      ...node,
      label: node.label || node.id,
    })),
    edges,
  };
}

// ── Building shapes ──────────────────────────────────────────────────────

const FONT_SIZE = 16;
const CHAR_WIDTH = FONT_SIZE * 0.56;
const LINE_HEIGHT = FONT_SIZE * 1.25;
const MAX_LABEL_WIDTH = 190;

const KIND_STYLE: Record<MermaidNodeKind, { fill: string; stroke: string }> = {
  rect: { fill: "#3B82F6", stroke: "#1E40AF" },
  rhombus: { fill: "#F59E0B", stroke: "#B45309" },
  circle: { fill: "#10B981", stroke: "#047857" },
};

function measureLabel(label: string) {
  const words = label.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length * CHAR_WIDTH > MAX_LABEL_WIDTH && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  const widest = Math.max(...lines.map((line) => line.length)) * CHAR_WIDTH;
  return { width: widest, height: lines.length * LINE_HEIGHT };
}

function nodeSize(node: MermaidNode) {
  const text = measureLabel(node.label);
  if (node.kind === "rhombus") {
    return { width: Math.max(130, text.width + 90), height: Math.max(84, text.height + 56) };
  }
  if (node.kind === "circle") {
    const diameter = Math.max(84, Math.max(text.width, text.height) + 44);
    return { width: diameter, height: diameter };
  }
  return { width: Math.max(120, text.width + 40), height: Math.max(56, text.height + 28) };
}

export type BuildOptions = {
  /** Canvas-space point the diagram is centred on. */
  center: { x: number; y: number };
  createId?: () => string;
};

/** Converts a parsed diagram into laid-out canvas shapes (nodes, labels, connectors). */
export function buildShapesFromDiagram(
  diagram: MermaidDiagram,
  options: BuildOptions,
): Shape[] {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const sizes = new Map(diagram.nodes.map((node) => [node.id, nodeSize(node)]));

  const positions = layoutLayered(
    diagram.nodes.map((node) => ({ id: node.id, ...sizes.get(node.id)! })),
    diagram.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    diagram.direction,
  );
  const rankOf = new Map(positions.map((p) => [p.id, p.rank]));

  // Centre the whole diagram on the requested point.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const position of positions) {
    const size = sizes.get(position.id)!;
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x + size.width);
    maxY = Math.max(maxY, position.y + size.height);
  }
  const offsetX = options.center.x - (minX + maxX) / 2;
  const offsetY = options.center.y - (minY + maxY) / 2;

  const shapeIdByNode = new Map<string, string>();
  const boxByNode = new Map<string, { x: number; y: number; w: number; h: number }>();
  const shapes: Shape[] = [];

  for (const node of diagram.nodes) {
    const position = positions.find((p) => p.id === node.id)!;
    const size = sizes.get(node.id)!;
    const x = position.x + offsetX;
    const y = position.y + offsetY;
    const id = createId();
    shapeIdByNode.set(node.id, id);
    boxByNode.set(node.id, { x, y, w: size.width, h: size.height });

    const style = {
      ...KIND_STYLE[node.kind],
      fillStyle: "solid" as const,
      strokeStyle: "solid" as const,
      strokeWidth: 2,
      roughness: 1,
      opacity: 100,
    };

    if (node.kind === "circle") {
      shapes.push({
        id,
        type: "circle",
        centerX: x + size.width / 2,
        centerY: y + size.height / 2,
        radiusX: size.width / 2,
        radiusY: size.height / 2,
        ...style,
      });
    } else {
      shapes.push({
        id,
        type: node.kind,
        x,
        y,
        width: size.width,
        height: size.height,
        ...style,
      });
    }

    const insetX = node.kind === "rect" ? 12 : size.width * 0.2;
    const insetY = node.kind === "rect" ? 8 : size.height * 0.25;
    const text = measureLabel(node.label);
    const textHeight = Math.min(size.height - insetY * 2, text.height);
    shapes.push({
      id: createId(),
      type: "text",
      parentId: id,
      x: x + insetX,
      y: y + (size.height - textHeight) / 2,
      width: size.width - insetX * 2,
      height: textHeight,
      text: node.label,
      fontSize: FONT_SIZE,
      stroke: "#FFFFFF",
      roughness: 1,
      strokeStyle: "solid",
    });
  }

  for (const edge of diagram.edges) {
    const from = boxByNode.get(edge.from);
    const to = boxByNode.get(edge.to);
    const fromId = shapeIdByNode.get(edge.from);
    const toId = shapeIdByNode.get(edge.to);
    if (!from || !to || !fromId || !toId) continue;

    const fromRank = rankOf.get(edge.from)!;
    const toRank = rankOf.get(edge.to)!;
    const { start, end } = connectorAnchors(
      diagram.direction,
      toRank > fromRank,
      toRank === fromRank,
    );
    const x1 = from.x + start[0]! * from.w;
    const y1 = from.y + start[1]! * from.h;
    const x2 = to.x + end[0]! * to.w;
    const y2 = to.y + end[1]! * to.h;

    shapes.push({
      id: createId(),
      type: edge.arrow ? "arrow" : "line",
      x1,
      y1,
      x2,
      y2,
      startBinding: { shapeId: fromId, relX: start[0]!, relY: start[1]! },
      endBinding: { shapeId: toId, relX: end[0]!, relY: end[1]! },
      stroke: "#94A3B8",
      strokeStyle: edge.style === "dashed" ? "dashed" : "solid",
      strokeWidth: 2,
      roughness: 1,
      opacity: 100,
    });

    if (edge.label) {
      const width = Math.max(24, edge.label.length * CHAR_WIDTH + 10);
      shapes.push({
        id: createId(),
        type: "text",
        x: (x1 + x2) / 2 - width / 2,
        y: (y1 + y2) / 2 - 11,
        width,
        height: 22,
        text: edge.label,
        fontSize: 14,
        stroke: "#CBD5E1",
        roughness: 1,
        strokeStyle: "solid",
      });
    }
  }

  return shapes;
}

export function mermaidToShapes(source: string, options: BuildOptions): Shape[] {
  return buildShapesFromDiagram(parseMermaidFlowchart(source), options);
}

// ── Exporting ─────────────────────────────────────────────────────────────

function escapeLabel(label: string) {
  const flat = label.replace(/\s+/g, " ").trim();
  return /["()[\]{}|<>]/.test(flat) ? `"${flat.replace(/"/g, "&quot;")}"` : flat;
}

/**
 * Best-effort Mermaid export. Only connectors bound on both ends to a
 * rect/circle/rhombus become edges; the result reports what was left out.
 */
export function shapesToMermaid(shapes: Shape[]): {
  code: string;
  nodeCount: number;
  edgeCount: number;
  skippedConnectors: number;
} {
  const nodeShapes = shapes.filter(
    (shape) =>
      shape.type === "rect" || shape.type === "circle" || shape.type === "rhombus",
  );
  const names = new Map(nodeShapes.map((shape, index) => [shape.id, `N${index + 1}`]));

  const labelFor = (parentId: string) =>
    shapes
      .filter(
        (shape): shape is Extract<Shape, { type: "text" }> =>
          shape.type === "text" && shape.parentId === parentId,
      )
      .map((shape) => shape.text)
      .join(" ");

  const lines = ["flowchart TD"];
  for (const shape of nodeShapes) {
    const name = names.get(shape.id)!;
    const label = escapeLabel(labelFor(shape.id) || name);
    if (shape.type === "circle") lines.push(`  ${name}((${label}))`);
    else if (shape.type === "rhombus") lines.push(`  ${name}{${label}}`);
    else lines.push(`  ${name}[${label}]`);
  }

  const looseTexts = shapes.filter(
    (shape): shape is Extract<Shape, { type: "text" }> =>
      shape.type === "text" && !shape.parentId,
  );

  let edgeCount = 0;
  let skippedConnectors = 0;
  for (const shape of shapes) {
    if (shape.type !== "arrow" && shape.type !== "line") continue;
    const from = shape.startBinding && names.get(shape.startBinding.shapeId);
    const to = shape.endBinding && names.get(shape.endBinding.shapeId);
    if (!from || !to) {
      skippedConnectors += 1;
      continue;
    }

    // A loose text sitting on the connector's midpoint is its label.
    const midX = (shape.x1 + shape.x2) / 2;
    const midY = (shape.y1 + shape.y2) / 2;
    const label = looseTexts.find((text) => {
      const box = convertToPoints(text);
      return (
        midX >= box.x1 - 20 && midX <= box.x2 + 20 &&
        midY >= box.y1 - 20 && midY <= box.y2 + 20
      );
    });

    const link = shape.type === "arrow" ? "-->" : "---";
    const dashed = shape.strokeStyle === "dashed" || shape.strokeStyle === "dotted";
    const symbol = dashed ? (shape.type === "arrow" ? "-.->" : "-.-") : link;
    lines.push(
      label
        ? `  ${from} ${symbol}|${escapeLabel(label.text)}| ${to}`
        : `  ${from} ${symbol} ${to}`,
    );
    edgeCount += 1;
  }

  return { code: lines.join("\n"), nodeCount: nodeShapes.length, edgeCount, skippedConnectors };
}
