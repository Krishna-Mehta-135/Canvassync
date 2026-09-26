import { describe, expect, it } from "vitest";
import type { Shape } from "../types";
import { bindConnectorsToContainers, bindTextToContainers } from "./labels";

const rect = (id: string, x: number, y: number, w: number, h: number): Shape => ({
  id, type: "rect", x, y, width: w, height: h,
});
const text = (id: string, x: number, y: number, w = 60, h = 20): Shape => ({
  id, type: "text", x, y, width: w, height: h, text: id, fontSize: 16,
});

describe("bindTextToContainers", () => {
  it("links a label to the smallest box containing it", () => {
    const shapes = [rect("big", 0, 0, 400, 300), rect("small", 50, 50, 150, 80), text("t", 70, 70)];
    const { shapes: out, linked } = bindTextToContainers(shapes);
    expect(linked).toBe(1);
    expect(out.find((s) => s.id === "t")).toMatchObject({ parentId: "small" });
  });

  it("leaves titles outside boxes and already-linked labels alone", () => {
    const shapes = [rect("a", 0, 0, 100, 50), text("title", 0, -60), { ...text("linked", 10, 10), parentId: "zzz" } as Shape];
    const { shapes: out, linked } = bindTextToContainers(shapes);
    expect(linked).toBe(0);
    expect(out.find((s) => s.id === "title")).not.toHaveProperty("parentId", "a");
    expect(out.find((s) => s.id === "linked")).toMatchObject({ parentId: "zzz" });
  });

  it("ignores text that only clips a box edge", () => {
    const { linked } = bindTextToContainers([rect("a", 0, 0, 100, 50), text("edge", 80, 40, 60, 20)]);
    expect(linked).toBe(0);
  });

  it("respects onlyIds", () => {
    const shapes = [rect("a", 0, 0, 200, 100), text("x", 10, 10), text("y", 10, 40)];
    const { shapes: out, linked } = bindTextToContainers(shapes, new Set(["y"]));
    expect(linked).toBe(1);
    expect(out.find((s) => s.id === "x")).not.toHaveProperty("parentId");
  });
});

describe("bindConnectorsToContainers", () => {
  it("binds endpoints that touch box edges and keeps their position", () => {
    const shapes: Shape[] = [
      rect("a", 0, 0, 100, 50),
      rect("b", 200, 0, 100, 50),
      { id: "l", type: "arrow", x1: 102, y1: 25, x2: 198, y2: 25 },
    ];
    const { shapes: out, bound } = bindConnectorsToContainers(shapes);
    expect(bound).toBe(2);
    const arrow = out.find((s) => s.id === "l");
    expect(arrow?.type === "arrow" && arrow.startBinding).toMatchObject({ shapeId: "a", relX: 1, relY: 0.5 });
    expect(arrow?.type === "arrow" && arrow.endBinding).toMatchObject({ shapeId: "b", relX: 0, relY: 0.5 });
  });

  it("leaves free endpoints and same-box loops alone", () => {
    const shapes: Shape[] = [
      rect("a", 0, 0, 100, 50),
      { id: "free", type: "line", x1: 500, y1: 500, x2: 600, y2: 600 },
      { id: "loop", type: "arrow", x1: 101, y1: 10, x2: 101, y2: 40 },
    ];
    expect(bindConnectorsToContainers(shapes).bound).toBe(0);
  });
});
