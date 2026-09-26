import { describe, expect, it } from "vitest";
import { recognizeStroke, snapSketches } from "./sketch";
import type { Shape } from "../types";

// Deterministic pseudo-noise so tests are stable.
let seed = 7;
const noise = (amount: number) => {
  seed = (seed * 16807) % 2147483647;
  return ((seed / 2147483647) - 0.5) * 2 * amount;
};

function densify(corners: { x: number; y: number }[], perEdge = 12, jitter = 3) {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < corners.length; i += 1) {
    const a = corners[i]!;
    const b = corners[(i + 1) % corners.length]!;
    for (let s = 0; s < perEdge; s += 1) {
      const t = s / perEdge;
      pts.push({ x: a.x + (b.x - a.x) * t + noise(jitter), y: a.y + (b.y - a.y) * t + noise(jitter) });
    }
  }
  pts.push({ ...pts[0]! });
  return pts;
}

const square = densify([{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 80 }, { x: 0, y: 80 }]);
const diamond = densify([{ x: 60, y: 0 }, { x: 120, y: 50 }, { x: 60, y: 100 }, { x: 0, y: 50 }]);
const circle = Array.from({ length: 48 }, (_, i) => {
  const a = (i / 48) * Math.PI * 2;
  return { x: 60 + Math.cos(a) * 60 + noise(3), y: 40 + Math.sin(a) * 40 + noise(3) };
});
circle.push({ ...circle[0]! });

describe("recognizeStroke", () => {
  it("recognizes a rough rectangle", () => {
    expect(recognizeStroke(square)?.kind).toBe("rect");
  });
  it("recognizes a diamond", () => {
    expect(recognizeStroke(diamond)?.kind).toBe("rhombus");
  });
  it("recognizes an ellipse", () => {
    expect(recognizeStroke(circle)?.kind).toBe("circle");
  });
  it("recognizes a straight line and rejects a wobbly arc", () => {
    const line = Array.from({ length: 20 }, (_, i) => ({ x: i * 10, y: i * 5 + noise(2) }));
    expect(recognizeStroke(line)?.kind).toBe("line");
    const arc = Array.from({ length: 20 }, (_, i) => ({ x: i * 10, y: Math.sin(i / 4) * 40 }));
    expect(recognizeStroke(arc)).toBeNull();
  });
  it("ignores tiny marks", () => {
    expect(recognizeStroke([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBeNull();
  });
});

describe("snapSketches", () => {
  const box = (id: string, x: number): Shape => ({ id, type: "rect", x, y: 0, width: 100, height: 60 });

  it("turns a stroke between two boxes into a bound arrow", () => {
    const stroke: Shape = {
      id: "s",
      type: "freehand",
      points: Array.from({ length: 16 }, (_, i) => ({ x: 104 + i * 6, y: 30 + noise(1) })),
    };
    const { shapes, recognized } = snapSketches(
      [box("a", 0), box("b", 200), stroke],
      new Set(["s"]),
      () => "new",
    );
    expect(recognized).toBe(1);
    const arrow = shapes.find((s) => s.id === "new");
    expect(arrow?.type).toBe("arrow");
    if (arrow?.type !== "arrow") return;
    expect(arrow.startBinding).toMatchObject({ shapeId: "a", relX: 1, relY: 0.5 });
    expect(arrow.endBinding).toMatchObject({ shapeId: "b", relX: 0, relY: 0.5 });
    expect(arrow.x1).toBe(100);
    expect(arrow.x2).toBe(200);
  });

  it("only touches targeted freehand shapes", () => {
    const stroke: Shape = { id: "s", type: "freehand", points: square };
    const other: Shape = { id: "o", type: "freehand", points: square };
    const { shapes } = snapSketches([stroke, other], new Set(["s"]), () => "new");
    expect(shapes.map((s) => s.type)).toEqual(["rect", "freehand"]);
  });
});
