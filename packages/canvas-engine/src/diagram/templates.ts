/*
templates.ts

Ready-made boards (sticky notes, kanban, retro, SWOT, mind map, journey map,
flowchart starter). Built from ordinary rect/circle/text/arrow shapes, so every
piece stays fully editable.
*/

import type { Shape } from "../types";
import { mermaidToShapes } from "./mermaid";
import { translateShape } from "./tidy";
import { convertToPoints } from "../geometry";

export type TemplateId =
  | "sticky"
  | "kanban"
  | "retro"
  | "swot"
  | "mindmap"
  | "journey"
  | "flowchart";

export type TemplateInfo = {
  id: TemplateId;
  name: string;
  description: string;
  emoji: string;
};

export const TEMPLATES: TemplateInfo[] = [
  { id: "sticky", name: "Sticky notes", description: "A handful of colourful notes to jot ideas on", emoji: "🗒️" },
  { id: "kanban", name: "Kanban board", description: "To do / Doing / Done columns with starter cards", emoji: "📋" },
  { id: "retro", name: "Retrospective", description: "Start / Stop / Continue with sticky notes", emoji: "🔁" },
  { id: "swot", name: "SWOT analysis", description: "Strengths, weaknesses, opportunities, threats", emoji: "🧭" },
  { id: "mindmap", name: "Mind map", description: "A central topic with five connected branches", emoji: "🧠" },
  { id: "journey", name: "User journey", description: "Five stages from awareness to advocacy", emoji: "🛤️" },
  { id: "flowchart", name: "Flowchart starter", description: "Start → process → decision → end", emoji: "🔀" },
];

type IdFactory = () => string;

const STICKY_COLORS = [
  { fill: "#FDE68A", stroke: "#F59E0B" }, // yellow
  { fill: "#BBF7D0", stroke: "#22C55E" }, // green
  { fill: "#FECACA", stroke: "#EF4444" }, // red
  { fill: "#BFDBFE", stroke: "#3B82F6" }, // blue
  { fill: "#E9D5FF", stroke: "#A855F7" }, // purple
  { fill: "#FED7AA", stroke: "#F97316" }, // orange
] as const;

const INK = "#1E1E1E";
const MUTED = "#94A3B8";

class Builder {
  shapes: Shape[] = [];
  constructor(private createId: IdFactory) {}

  text(
    x: number,
    y: number,
    width: number,
    height: number,
    text: string,
    options: { fontSize?: number; color?: string; parentId?: string } = {},
  ) {
    const id = this.createId();
    this.shapes.push({
      id,
      type: "text",
      x,
      y,
      width,
      height,
      text,
      fontSize: options.fontSize ?? 16,
      stroke: options.color ?? "#E2E8F0",
      parentId: options.parentId,
      roughness: 1,
      strokeStyle: "solid",
    });
    return id;
  }

  /** A filled rect with its label bound inside. */
  card(
    x: number,
    y: number,
    width: number,
    height: number,
    label: string,
    style: { fill: string; stroke: string; color?: string; fontSize?: number },
    kind: "rect" | "circle" = "rect",
  ) {
    const id = this.createId();
    const common = {
      id,
      stroke: style.stroke,
      fill: style.fill,
      fillStyle: "solid" as const,
      strokeStyle: "solid" as const,
      strokeWidth: 2,
      roughness: 1,
      opacity: 100,
    };
    if (kind === "circle") {
      this.shapes.push({
        ...common,
        type: "circle",
        centerX: x + width / 2,
        centerY: y + height / 2,
        radiusX: width / 2,
        radiusY: height / 2,
      });
    } else {
      this.shapes.push({ ...common, type: "rect", x, y, width, height });
    }
    const insetX = kind === "circle" ? width * 0.18 : 12;
    const insetY = kind === "circle" ? height * 0.3 : 12;
    this.text(x + insetX, y + insetY, width - insetX * 2, height - insetY * 2, label, {
      fontSize: style.fontSize ?? 16,
      color: style.color ?? INK,
      parentId: id,
    });
    return id;
  }

  /** Dashed lane / quadrant background. */
  lane(x: number, y: number, width: number, height: number) {
    const id = this.createId();
    this.shapes.push({
      id,
      type: "rect",
      x,
      y,
      width,
      height,
      stroke: MUTED,
      strokeStyle: "dashed",
      strokeWidth: 2,
      roughness: 1,
      opacity: 100,
    });
    return id;
  }

  arrow(fromId: string, toId: string, from: [number, number], to: [number, number]) {
    const byId = new Map(this.shapes.map((shape) => [shape.id, shape]));
    const a = convertToPoints(byId.get(fromId)!);
    const b = convertToPoints(byId.get(toId)!);
    this.shapes.push({
      id: this.createId(),
      type: "arrow",
      x1: a.x1 + from[0] * (a.x2 - a.x1),
      y1: a.y1 + from[1] * (a.y2 - a.y1),
      x2: b.x1 + to[0] * (b.x2 - b.x1),
      y2: b.y1 + to[1] * (b.y2 - b.y1),
      startBinding: { shapeId: fromId, relX: from[0], relY: from[1] },
      endBinding: { shapeId: toId, relX: to[0], relY: to[1] },
      stroke: MUTED,
      strokeWidth: 2,
      roughness: 1,
      opacity: 100,
    });
  }
}

const sticky = (index: number) => STICKY_COLORS[index % STICKY_COLORS.length]!;

function buildSticky(b: Builder) {
  const labels = ["Idea", "Question", "Risk", "Next step", "Nice to have", "Done!"];
  labels.forEach((label, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    b.card(col * 210, row * 200, 180, 170, label, { ...sticky(i), fontSize: 20 });
  });
}

function buildKanban(b: Builder) {
  const columns = [
    { title: "To do", cards: ["Research options", "Draft the plan"] },
    { title: "Doing", cards: ["Build the first version"] },
    { title: "Done", cards: ["Kick-off meeting"] },
  ];
  columns.forEach((column, index) => {
    const x = index * 300;
    b.lane(x, 60, 270, 520);
    b.text(x + 12, 12, 246, 36, column.title, { fontSize: 24, color: "#F8FAFC" });
    column.cards.forEach((label, cardIndex) => {
      b.card(x + 20, 84 + cardIndex * 130, 230, 100, label, sticky(index * 2 + cardIndex));
    });
  });
}

function buildRetro(b: Builder) {
  const columns = [
    { title: "Start", color: 1, notes: ["We should…", "Try…"] },
    { title: "Stop", color: 2, notes: ["We shouldn't…", "Too much…"] },
    { title: "Continue", color: 3, notes: ["Keep doing…", "Great job on…"] },
  ];
  columns.forEach((column, index) => {
    const x = index * 300;
    b.lane(x, 60, 270, 480);
    b.text(x + 12, 12, 246, 36, column.title, { fontSize: 24, color: "#F8FAFC" });
    column.notes.forEach((note, noteIndex) => {
      b.card(x + 25, 90 + noteIndex * 190, 220, 160, note, { ...sticky(column.color), fontSize: 18 });
    });
  });
}

function buildSwot(b: Builder) {
  const quadrants = [
    { title: "Strengths", color: 1 },
    { title: "Weaknesses", color: 2 },
    { title: "Opportunities", color: 3 },
    { title: "Threats", color: 5 },
  ];
  quadrants.forEach((quadrant, index) => {
    const x = (index % 2) * 340;
    const y = Math.floor(index / 2) * 300;
    b.lane(x, y, 320, 280);
    b.text(x + 14, y + 12, 292, 34, quadrant.title, { fontSize: 22, color: "#F8FAFC" });
    b.card(x + 30, y + 64, 260, 90, "Add a note…", sticky(quadrant.color));
  });
}

function buildMindMap(b: Builder) {
  const centre = b.card(-90, -60, 180, 120, "Main topic", { fill: "#FDE68A", stroke: "#F59E0B", fontSize: 20 }, "circle");
  const branches = 5;
  for (let i = 0; i < branches; i += 1) {
    const angle = -Math.PI / 2 + (i / branches) * Math.PI * 2;
    const cx = Math.cos(angle) * 300;
    const cy = Math.sin(angle) * 230;
    const id = b.card(cx - 70, cy - 40, 140, 80, `Branch ${i + 1}`, { ...sticky(i + 1), fontSize: 16 }, "circle");
    // Anchor on the sides facing each other.
    const horizontal = Math.abs(cx) > Math.abs(cy);
    const from: [number, number] = horizontal ? (cx > 0 ? [1, 0.5] : [0, 0.5]) : cy > 0 ? [0.5, 1] : [0.5, 0];
    const to: [number, number] = horizontal ? (cx > 0 ? [0, 0.5] : [1, 0.5]) : cy > 0 ? [0.5, 0] : [0.5, 1];
    b.arrow(centre, id, from, to);
  }
}

function buildJourney(b: Builder) {
  const stages = ["Awareness", "Consideration", "Purchase", "Onboarding", "Advocacy"];
  stages.forEach((stage, index) => {
    const x = index * 250;
    const header = b.card(x, 0, 220, 70, stage, { ...sticky(index), fontSize: 18 });
    b.lane(x, 100, 220, 380);
    b.text(x + 12, 112, 196, 60, "Actions", { fontSize: 14, color: MUTED });
    b.text(x + 12, 236, 196, 60, "Thoughts", { fontSize: 14, color: MUTED });
    b.text(x + 12, 360, 196, 60, "Pain points / opportunities", { fontSize: 14, color: MUTED });
    if (index > 0) {
      const previous = b.shapes.find((shape) => shape.type === "rect" && shape.x === (index - 1) * 250 && shape.y === 0);
      if (previous) b.arrow(previous.id, header, [1, 0.5], [0, 0.5]);
    }
  });
}

export function buildTemplate(
  id: TemplateId,
  center: { x: number; y: number },
  createId: IdFactory = () => crypto.randomUUID(),
): Shape[] {
  let shapes: Shape[];

  if (id === "flowchart") {
    shapes = mermaidToShapes(
      `flowchart TD
        S((Start)) --> P[Do the work]
        P --> D{Good enough?}
        D -->|Yes| E((Finish))
        D -->|No| P`,
      { center: { x: 0, y: 0 }, createId },
    );
  } else {
    const builder = new Builder(createId);
    const builders: Record<Exclude<TemplateId, "flowchart">, (b: Builder) => void> = {
      sticky: buildSticky,
      kanban: buildKanban,
      retro: buildRetro,
      swot: buildSwot,
      mindmap: buildMindMap,
      journey: buildJourney,
    };
    builders[id](builder);
    shapes = builder.shapes;
  }

  // Centre the result on the requested point.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const shape of shapes) {
    const box = convertToPoints(shape);
    minX = Math.min(minX, box.x1);
    minY = Math.min(minY, box.y1);
    maxX = Math.max(maxX, box.x2);
    maxY = Math.max(maxY, box.y2);
  }
  const dx = center.x - (minX + maxX) / 2;
  const dy = center.y - (minY + maxY) / 2;
  return shapes.map((shape) => translateShape(shape, dx, dy));
}
