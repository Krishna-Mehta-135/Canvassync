import { describe, expect, it } from "vitest";
import { layoutLayered } from "./layout";
import {
  MermaidParseError,
  mermaidToShapes,
  parseMermaidFlowchart,
  shapesToMermaid,
} from "./mermaid";
import { tidyLayout } from "./tidy";

let counter = 0;
const createId = () => `id-${(counter += 1)}`;

describe("parseMermaidFlowchart", () => {
  it("parses shapes, labels, chains and fan-out", () => {
    const diagram = parseMermaidFlowchart(`
      flowchart LR
      A[Client] -->|HTTPS| B{Gateway}
      B --> C((Cache)) & D([API])
      %% a comment
      style A fill:#f00
      D -.-> E[(DB)]
    `);
    expect(diagram.direction).toBe("LR");
    expect(diagram.nodes.map((n) => [n.id, n.label, n.kind])).toEqual([
      ["A", "Client", "rect"],
      ["B", "Gateway", "rhombus"],
      ["C", "Cache", "circle"],
      ["D", "API", "rect"],
      ["E", "DB", "rect"],
    ]);
    expect(diagram.edges).toEqual([
      { from: "A", to: "B", label: "HTTPS", style: "solid", arrow: true },
      { from: "B", to: "C", label: undefined, style: "solid", arrow: true },
      { from: "B", to: "D", label: undefined, style: "solid", arrow: true },
      { from: "D", to: "E", label: undefined, style: "dashed", arrow: true },
    ]);
  });

  it("supports text-form labels and open links", () => {
    const diagram = parseMermaidFlowchart(
      "graph TD\nA -- yes --> B\nB --- C\nC == big ==> D",
    );
    expect(diagram.edges.map((e) => [e.from, e.to, e.label, e.arrow])).toEqual([
      ["A", "B", "yes", true],
      ["B", "C", undefined, false],
      ["C", "D", "big", true],
    ]);
  });

  it("rejects non-flowchart input", () => {
    expect(() => parseMermaidFlowchart("sequenceDiagram\nA->>B: hi")).toThrow(
      MermaidParseError,
    );
  });
});

describe("layoutLayered", () => {
  it("ranks a chain top-down and survives cycles", () => {
    const nodes = ["a", "b", "c"].map((id) => ({ id, width: 100, height: 50 }));
    const positions = layoutLayered(
      nodes,
      [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "a" },
      ],
      "TD",
    );
    const y = Object.fromEntries(positions.map((p) => [p.id, p.y]));
    expect(y.a).toBeLessThan(y.b!);
    expect(y.b).toBeLessThan(y.c!);
  });

  it("lays out left-to-right", () => {
    const positions = layoutLayered(
      [
        { id: "a", width: 100, height: 50 },
        { id: "b", width: 100, height: 50 },
      ],
      [{ from: "a", to: "b" }],
      "LR",
    );
    expect(positions.find((p) => p.id === "b")!.x).toBeGreaterThan(
      positions.find((p) => p.id === "a")!.x,
    );
  });
});

describe("shapes round trip", () => {
  it("builds bound shapes and exports them back to Mermaid", () => {
    const shapes = mermaidToShapes("flowchart TD\nA[Start] -->|go| B{Ok?}", {
      center: { x: 0, y: 0 },
      createId,
    });
    expect(shapes.filter((s) => s.type === "arrow")).toHaveLength(1);
    const arrow = shapes.find((s) => s.type === "arrow");
    expect(arrow && arrow.type === "arrow" && arrow.startBinding).toBeTruthy();

    const exported = shapesToMermaid(shapes);
    expect(exported.nodeCount).toBe(2);
    expect(exported.edgeCount).toBe(1);
    expect(exported.code).toContain("N1[Start]");
    expect(exported.code).toContain("N2{Ok?}");
    expect(exported.code).toMatch(/N1 -->\|go\| N2/);
  });

  it("tidy layout re-attaches connectors and returns null with no edges", () => {
    const shapes = mermaidToShapes("flowchart TD\nA --> B\nA --> C", {
      center: { x: 0, y: 0 },
      createId,
    });
    const scrambled = shapes.map((s) =>
      s.type === "rect" ? { ...s, x: s.x + 500, y: s.y - 300 } : s,
    );
    const tidy = tidyLayout(scrambled, "LR")!;
    expect(tidy).toHaveLength(shapes.length);
    const rects = tidy.filter((s) => s.type === "rect");
    const arrows = tidy.filter((s) => s.type === "arrow");
    for (const arrow of arrows) {
      if (arrow.type !== "arrow" || !arrow.endBinding) continue;
      const target = rects.find((r) => r.id === arrow.endBinding!.shapeId);
      expect(target?.type).toBe("rect");
      if (target?.type !== "rect") continue;
      // LR tidy re-anchors connectors to the target's left edge (relX 0, relY 0.5).
      expect(arrow.endBinding).toMatchObject({ relX: 0, relY: 0.5 });
      expect(target.x + target.width * arrow.endBinding.relX).toBeCloseTo(arrow.x2, 5);
      expect(target.y + target.height * arrow.endBinding.relY).toBeCloseTo(arrow.y2, 5);
    }
    expect(tidyLayout(rects, "TD")).toBeNull();

    // Unconnected shapes are left alone.
    const loner = { ...rects[0]!, id: "loner", x: 5000, y: 5000 };
    const withLoner = tidyLayout([...scrambled, loner], "TD")!;
    expect(withLoner.find((s) => s.id === "loner")).toMatchObject({ x: 5000, y: 5000 });
  });
});
