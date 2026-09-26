import { convertToPoints, type Shape, type Viewport } from "@repo/canvas-engine";

export const MIN_SCALE = 0.05;

/** Viewport that centres and fits all shapes inside a width×height surface. */
export function fitViewport(
  shapes: Shape[],
  width: number,
  height: number,
  options: { padding?: number; maxScale?: number } = {},
): Viewport {
  const padding = options.padding ?? 100;
  const maxScale = options.maxScale ?? 1.5;
  if (shapes.length === 0) return { x: width / 2, y: height / 2, scale: 1 };

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

  const scale = Math.min(
    maxScale,
    Math.max(
      MIN_SCALE,
      Math.min(
        width / Math.max(1, maxX - minX + padding * 2),
        height / Math.max(1, maxY - minY + padding * 2),
      ),
    ),
  );
  return {
    scale,
    x: width / 2 - ((minX + maxX) / 2) * scale,
    y: height / 2 - ((minY + maxY) / 2) * scale,
  };
}
