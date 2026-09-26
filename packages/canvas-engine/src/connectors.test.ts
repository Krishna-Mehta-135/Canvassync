import { describe, expect, it } from "vitest";
import { getConnectorRoutePoints } from "./connectors";

const base = { x1: 100, y1: 0, x2: 0, y2: 100 };

describe("getConnectorRoutePoints", () => {
  it("keeps the legacy horizontal-first route without bindings", () => {
    const route = getConnectorRoutePoints({ ...base, x1: 0, x2: 200, y2: 50 });
    expect(route.map((p) => p.y)).toEqual([0, 0, 50, 50]);
  });

  it("routes bottom→top anchors vertically even when the run is wider than tall", () => {
    const route = getConnectorRoutePoints({
      x1: 300,
      y1: 0,
      x2: 100,
      y2: 60,
      startBinding: { relX: 0.5, relY: 1 },
      endBinding: { relX: 0.5, relY: 0 },
    });
    expect(route).toEqual([
      { x: 300, y: 0 },
      { x: 300, y: 30 },
      { x: 100, y: 30 },
      { x: 100, y: 60 },
    ]);
  });

  it("ignores interior anchors", () => {
    const route = getConnectorRoutePoints({
      ...base,
      x1: 0,
      x2: 200,
      y2: 50,
      startBinding: { relX: 0.3, relY: 0.6 },
      endBinding: { relX: 0.5, relY: 0.5 },
    });
    expect(route.map((p) => p.y)).toEqual([0, 0, 50, 50]);
  });

  it("makes an L-route for mixed axes", () => {
    const route = getConnectorRoutePoints({
      x1: 0,
      y1: 0,
      x2: 100,
      y2: 80,
      startBinding: { relX: 0.5, relY: 1 },
      endBinding: { relX: 0, relY: 0.5 },
    });
    expect(route).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 80 },
      { x: 100, y: 80 },
    ]);
  });
});
