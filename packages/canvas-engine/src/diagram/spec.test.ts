import { describe, expect, it } from "vitest";
import { buildDiagramFromSpec, normalizeDiagramSpec } from "./spec";
import { convertToPoints } from "../geometry";
import type { Shape } from "../types";

const spec = normalizeDiagramSpec({
  title: "Checkout",
  direction: "LR",
  nodes: [
    { id: "cart", label: "Cart Service", tone: "blue" },
    { id: "pay", label: "Payments Gateway", tone: "blue" },
    { id: "risk", label: "Risk > 80?", kind: "rhombus", tone: "amber" },
    { id: "review", label: "Manual Review", tone: "red" },
    { id: "db", label: "Ledger", kind: "circle", tone: "green" },
  ],
  edges: [
    { from: "cart", to: "pay" },
    { from: "pay", to: "risk" },
    { from: "risk", to: "review", label: "Yes" },
    { from: "risk", to: "db", label: "No", dashed: true },
  ],
});

describe("normalizeDiagramSpec", () => {
  it("drops unusable nodes and edges and defaults the rest", () => {
    const out = normalizeDiagramSpec({
      nodes: [
        { id: "a", label: "A", kind: "weird", tone: "pink" },
        { id: "a", label: "dup" },
        { id: "b", label: "B" },
        { label: "no id" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "b" },
        { from: "a", to: "zzz" },
        { from: "b", to: "b" },
      ],
    });
    expect(out?.nodes.map((n) => [n.id, n.kind, n.tone])).toEqual([
      ["a", "rect", undefined],
      ["b", "rect", undefined],
    ]);
    expect(out?.edges).toHaveLength(1);
    expect(out?.direction).toBe("TD");
  });

  it("rejects specs with fewer than two nodes", () => {
    expect(normalizeDiagramSpec({ nodes: [{ id: "a", label: "A" }], edges: [] })).toBeNull();
    expect(normalizeDiagramSpec("nope")).toBeNull();
  });
});

describe("buildDiagramFromSpec", () => {
  const shapes = buildDiagramFromSpec(spec!, { center: { x: 500, y: 400 } });
  const nodes = shapes.filter((s) => s.type === "rect" || s.type === "rhombus" || s.type === "circle");
  const connectors = shapes.filter((s): s is Extract<Shape, { type: "arrow" }> => s.type === "arrow");

  it("starts with the title and creates every node and edge", () => {
    expect(shapes[0]?.type).toBe("text");
    expect(nodes).toHaveLength(5);
    expect(connectors).toHaveLength(4);
  });

  it("binds every connector to real nodes and every node label to its node", () => {
    const ids = new Set(nodes.map((n) => n.id));
    for (const c of connectors) {
      expect(ids.has(c.startBinding!.shapeId)).toBe(true);
      expect(ids.has(c.endBinding!.shapeId)).toBe(true);
    }
    const labels = shapes.filter((s) => s.type === "text" && s.parentId);
    expect(labels).toHaveLength(5);
  });

  it("never overlaps nodes", () => {
    const boxes = nodes.map((n) => convertToPoints(n));
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlap = a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
        expect(overlap).toBe(false);
      }
    }
  });

  it("uses crisp strokes and tone colours", () => {
    expect(nodes.every((n) => n.roughness === 0)).toBe(true);
    expect(nodes.find((n) => n.type === "rhombus")?.fill).toBe("#F59E0B");
  });
});
