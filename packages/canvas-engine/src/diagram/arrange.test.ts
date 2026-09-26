import { describe, expect, it } from "vitest";
import type { Shape } from "../types";
import { alignShapes, distributeShapes } from "./arrange";

const rect = (id: string, x: number, y: number, w = 100, h = 50): Shape => ({
  id,
  type: "rect",
  x,
  y,
  width: w,
  height: h,
});
const ids = (...list: string[]) => new Set(list);

describe("alignShapes", () => {
  const shapes = [rect("a", 0, 0), rect("b", 200, 80, 60, 50), rect("c", 400, 200, 100, 100)];

  it("aligns left / right / centre", () => {
    const left = alignShapes(shapes, ids("a", "b", "c"), "left")!;
    expect(left.map((s) => (s.type === "rect" ? s.x : NaN))).toEqual([0, 0, 0]);

    const right = alignShapes(shapes, ids("a", "b", "c"), "right")!;
    expect(right.map((s) => (s.type === "rect" ? s.x + s.width : NaN))).toEqual([500, 500, 500]);

    const centre = alignShapes(shapes, ids("a", "b", "c"), "hcenter")!;
    const centres = centre.map((s) => (s.type === "rect" ? s.x + s.width / 2 : NaN));
    expect(new Set(centres).size).toBe(1);
  });

  it("aligns top and bottom", () => {
    const top = alignShapes(shapes, ids("a", "b", "c"), "top")!;
    expect(top.map((s) => (s.type === "rect" ? s.y : NaN))).toEqual([0, 0, 0]);
    const bottom = alignShapes(shapes, ids("a", "b", "c"), "bottom")!;
    expect(bottom.map((s) => (s.type === "rect" ? s.y + s.height : NaN))).toEqual([300, 300, 300]);
  });

  it("needs two shapes and returns null when nothing moves", () => {
    expect(alignShapes(shapes, ids("a"), "left")).toBeNull();
    expect(alignShapes([rect("a", 0, 0), rect("b", 0, 90)], ids("a", "b"), "left")).toBeNull();
  });

  it("moves bound labels and re-anchors connectors", () => {
    const withExtras: Shape[] = [
      rect("a", 0, 0),
      rect("b", 200, 100),
      { id: "t", type: "text", parentId: "b", x: 210, y: 110, width: 80, height: 20, text: "B", fontSize: 16 },
      {
        id: "arrow",
        type: "arrow",
        x1: 100,
        y1: 25,
        x2: 250,
        y2: 100,
        startBinding: { shapeId: "a", relX: 1, relY: 0.5 },
        endBinding: { shapeId: "b", relX: 0.5, relY: 0 },
      },
    ];
    const out = alignShapes(withExtras, ids("a", "b", "t"), "top")!;
    const b = out.find((s) => s.id === "b")!;
    expect(b.type === "rect" && b.y).toBe(0);
    const label = out.find((s) => s.id === "t")!;
    expect(label.type === "text" && label.y).toBe(10);
    const arrow = out.find((s) => s.id === "arrow")!;
    expect(arrow.type === "arrow" && [arrow.x2, arrow.y2]).toEqual([250, 0]);
  });
});

describe("distributeShapes", () => {
  it("spaces shapes evenly and keeps the outer two fixed", () => {
    const shapes = [rect("a", 0, 0), rect("b", 110, 0), rect("c", 500, 0)];
    const out = distributeShapes(shapes, ids("a", "b", "c"), "horizontal")!;
    const xs = out.map((s) => (s.type === "rect" ? s.x : NaN));
    expect(xs[0]).toBe(0);
    expect(xs[2]).toBe(500);
    expect(xs[1]).toBe(250); // gap = (600 - 300) / 2 = 150 → 100 + 150
  });

  it("needs three shapes", () => {
    expect(distributeShapes([rect("a", 0, 0), rect("b", 300, 0)], ids("a", "b"), "horizontal")).toBeNull();
  });
});
