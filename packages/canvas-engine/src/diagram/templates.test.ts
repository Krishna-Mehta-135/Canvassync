import { describe, expect, it } from "vitest";
import { convertToPoints } from "../geometry";
import { TEMPLATES, buildTemplate } from "./templates";

describe("buildTemplate", () => {
  for (const template of TEMPLATES) {
    it(`${template.id}: builds unique ids, valid bindings and is centred`, () => {
      let n = 0;
      const shapes = buildTemplate(template.id, { x: 1000, y: -500 }, () => `id-${(n += 1)}`);
      expect(shapes.length).toBeGreaterThan(0);

      const ids = shapes.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      const known = new Set(ids);

      for (const shape of shapes) {
        if (shape.type === "text" && shape.parentId) expect(known.has(shape.parentId)).toBe(true);
        if (shape.type === "arrow" || shape.type === "line") {
          if (shape.startBinding) expect(known.has(shape.startBinding.shapeId)).toBe(true);
          if (shape.endBinding) expect(known.has(shape.endBinding.shapeId)).toBe(true);
        }
      }

      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const shape of shapes) {
        const box = convertToPoints(shape);
        minX = Math.min(minX, box.x1);
        maxX = Math.max(maxX, box.x2);
        minY = Math.min(minY, box.y1);
        maxY = Math.max(maxY, box.y2);
      }
      expect((minX + maxX) / 2).toBeCloseTo(1000, 3);
      expect((minY + maxY) / 2).toBeCloseTo(-500, 3);
    });
  }
});
