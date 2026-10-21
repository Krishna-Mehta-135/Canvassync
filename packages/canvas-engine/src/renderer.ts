/*
renderer.ts

Responsible for visual output of the canvas.

Responsibilities:
- draw shapes
- draw selection UI (bounding box + resize handles)

Constraints:
- PURE rendering layer (no state mutation)
- does not handle interaction or logic
- reflects the current state onto pixels

Rendering model:
- immediate mode → entire canvas is redrawn every frame
*/

import { Shape } from "./types";
import { getTextRenderMetrics } from "./textMetrics";
import { Viewport, worldToScreenPoint } from "./utils";
import { getArrowHeadPoints, getConnectorRoutePoints } from "./connectors";
import rough from "roughjs/bin/rough";
import type { Options as RoughOptions } from "roughjs/bin/core";

const DEFAULT_STROKE_WIDTH = 2;
const ROUGHJS_THRESHOLD = 0.5;
const HANDLE_COLOR = "#8d8ac5";
const CONNECTOR_TARGET_HIGHLIGHT_COLOR = "#3b82f6";
const SELECTION_PADDING = 6;
const HANDLE_SIZE = 12;
const fillPatternCache = new Map<string, CanvasPattern | null>();
const roughCanvasCache = new WeakMap<
  HTMLCanvasElement,
  ReturnType<typeof rough.canvas>
>();

// Warm "drafting paper" surfaces: they match the app chrome tokens in globals.css.
const PAPER_DARK = {
  background: "#15140e",
  stroke: "#efeadc",
  grid: "rgba(239, 234, 220, 0.16)",
};
const PAPER_LIGHT = {
  background: "#f3efe4",
  stroke: "#17150f",
  grid: "rgba(23, 21, 15, 0.20)",
};

function getThemePalette() {
  if (typeof document === "undefined") return PAPER_DARK;
  return document.documentElement.getAttribute("data-theme") === "light"
    ? PAPER_LIGHT
    : PAPER_DARK;
}

type SelectionBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function rectBounds(x: number, y: number, width: number, height: number) {
  const safeX = finiteOr(x, 0);
  const safeY = finiteOr(y, 0);
  const safeWidth = finiteOr(width, 0);
  const safeHeight = finiteOr(height, 0);
  const x2 = safeX + safeWidth;
  const y2 = safeY + safeHeight;

  return {
    x: Math.min(safeX, x2),
    y: Math.min(safeY, y2),
    width: Math.abs(x2 - safeX),
    height: Math.abs(y2 - safeY),
  };
}

function getShapeOpacity(shape: Shape) {
  const raw = shape.opacity ?? 100;
  return Math.max(0.05, Math.min(1, raw / 100));
}

function getFillOpacity(shape: Shape) {
  const baseOpacity = getShapeOpacity(shape);
  return Math.max(0.08, Math.min(0.6, baseOpacity * 0.38));
}

function withAlpha(color: string, alpha: number) {
  const clampedAlpha = Math.max(0, Math.min(1, alpha));
  const hex = color.trim().replace("#", "");

  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${clampedAlpha})`;
  }

  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    const r = Number.parseInt(`${hex[0]}${hex[0]}`, 16);
    const g = Number.parseInt(`${hex[1]}${hex[1]}`, 16);
    const b = Number.parseInt(`${hex[2]}${hex[2]}`, 16);
    return `rgba(${r}, ${g}, ${b}, ${clampedAlpha})`;
  }

  return color;
}

function hashShapeSeed(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }

  const normalized = Math.abs(hash) % 2147483646;
  return normalized + 1;
}

function getRoughCanvas(ctx: CanvasRenderingContext2D) {
  const canvas = ctx.canvas;
  if (!canvas) return null;

  const cached = roughCanvasCache.get(canvas);
  if (cached) return cached;

  const created = rough.canvas(canvas);
  roughCanvasCache.set(canvas, created);
  return created;
}

function getRoughOptions(shape: Shape, viewportScale: number): RoughOptions {
  const roughness = Math.max(
    shape.type === "line" || shape.type === "arrow" ? 1.2 : 0.8,
    getEffectiveRoughness(shape),
  );
  const strokeLineDash = getStrokeDash(shape, viewportScale);
  return {
    stroke: shape.stroke || getThemePalette().stroke,
    strokeWidth: getViewportAdjustedStrokeWidth(shape, viewportScale),
    roughness,
    bowing: Math.max(0.4, roughness * 0.8),
    seed: hashShapeSeed(shape.id),
    strokeLineDash,
  };
}

function shouldUseRoughJs(shape: Shape) {
  if (shape.type === "line" || shape.type === "arrow") {
    return false;
  }

  return getSloppiness(shape) >= ROUGHJS_THRESHOLD;
}

function getSloppiness(shape: Shape) {
  return Math.max(0, Math.min(5, shape.roughness ?? 0));
}

function getEffectiveRoughness(shape: Shape) {
  const sloppiness = getSloppiness(shape);
  if (sloppiness <= 0) {
    return 0;
  }

  // Make low and mid slider values visibly affect the shape.
  return 0.9 + sloppiness * 1.1;
}

function getStrokeWidth(shape: Shape) {
  return Math.max(1, Math.min(12, shape.strokeWidth ?? DEFAULT_STROKE_WIDTH));
}

function getViewportAdjustedStrokeWidth(shape: Shape, viewportScale: number) {
  const safeScale = Math.max(0.01, viewportScale || 1);
  return getStrokeWidth(shape) / safeScale;
}

function getStrokeDash(shape: Shape, viewportScale = 1) {
  const strokeWidth = getViewportAdjustedStrokeWidth(shape, viewportScale);
  const style = shape.strokeStyle ?? "solid";

  if (style === "dashed") {
    return [strokeWidth * 4, strokeWidth * 2.5];
  }

  if (style === "dotted") {
    return [strokeWidth, strokeWidth * 2.2];
  }

  return [];
}

function applyStrokeStyle(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  viewportScale = 1,
) {
  ctx.setLineDash(getStrokeDash(shape, viewportScale));
}

function applyRoughness(ctx: CanvasRenderingContext2D, shape: Shape) {
  if (shape.type === "line" || shape.type === "arrow") {
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    return;
  }

  const sloppiness = getSloppiness(shape);
  if (sloppiness <= 0) {
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    return;
  }

  ctx.shadowColor = ctx.strokeStyle as string;
  ctx.shadowBlur = sloppiness * 1.8;
}

function getFillPattern(
  ctx: CanvasRenderingContext2D,
  style: NonNullable<Shape["fillStyle"]>,
  color: string,
) {
  const key = `${style}:${color}`;
  if (fillPatternCache.has(key)) {
    return fillPatternCache.get(key) ?? null;
  }

  if (typeof document === "undefined") {
    fillPatternCache.set(key, null);
    return null;
  }

  const patternCanvas = document.createElement("canvas");
  patternCanvas.width = 16;
  patternCanvas.height = 16;
  const pctx = patternCanvas.getContext("2d");
  if (!pctx) {
    fillPatternCache.set(key, null);
    return null;
  }

  pctx.strokeStyle = color;
  pctx.fillStyle = color;
  pctx.lineWidth = 1;

  if (style === "hachure") {
    pctx.beginPath();
    pctx.moveTo(0, 16);
    pctx.lineTo(16, 0);
    pctx.stroke();
  }

  if (style === "cross-hatch") {
    pctx.beginPath();
    pctx.moveTo(0, 16);
    pctx.lineTo(16, 0);
    pctx.moveTo(0, 0);
    pctx.lineTo(16, 16);
    pctx.stroke();
  }

  if (style === "dots") {
    pctx.beginPath();
    pctx.arc(4, 4, 1.4, 0, Math.PI * 2);
    pctx.arc(12, 12, 1.4, 0, Math.PI * 2);
    pctx.fill();
  }

  const pattern = ctx.createPattern(patternCanvas, "repeat");
  fillPatternCache.set(key, pattern);
  return pattern;
}

function applyShapeFill(ctx: CanvasRenderingContext2D, shape: Shape) {
  if (
    (shape.type !== "rect" &&
      shape.type !== "circle" &&
      shape.type !== "rhombus") ||
    !shape.fill
  )
    return;

  const fillColor = withAlpha(shape.fill, getFillOpacity(shape));

  if (!shape.fillStyle || shape.fillStyle === "solid") {
    ctx.fillStyle = fillColor;
    ctx.fill();
    return;
  }

  const pattern = getFillPattern(ctx, shape.fillStyle, fillColor);
  if (pattern) {
    const anchorX =
      shape.type === "circle" ? shape.centerX - shape.radiusX : shape.x;
    const anchorY =
      shape.type === "circle" ? shape.centerY - shape.radiusY : shape.y;

    if (typeof pattern.setTransform === "function") {
      pattern.setTransform(new DOMMatrix().translate(anchorX, anchorY));
    }

    ctx.fillStyle = pattern;
    ctx.fill();
  }
}

const DEFAULT_VIEWPORT: Viewport = {
  x: 0,
  y: 0,
  scale: 1,
};

// -------------------- DRAW MAP --------------------

/**
 * Maps shape type → corresponding draw function.
 *
 * Avoids large condition chains and keeps rendering extensible.
 */
const drawMap: {
  [K in Shape["type"]]: (
    ctx: CanvasRenderingContext2D,
    shape: Extract<Shape, { type: K }>,
    viewportScale: number,
  ) => void;
} = {
  rect: drawRectangle,
  circle: drawCircle,
  rhombus: drawRhombus,
  line: drawLine,
  arrow: drawArrow,
  text: drawText,
  freehand: drawFreehand,
};

// -------------------- ROUNDED RECT --------------------

/**
 * Draws a rounded rectangle path.
 *
 * Radius is clamped so it never exceeds half the width/height.
 */
function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);

  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawRhombusPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const midX = x + width / 2;
  const midY = y + height / 2;

  ctx.beginPath();
  ctx.moveTo(midX, y);
  ctx.lineTo(x + width, midY);
  ctx.lineTo(midX, y + height);
  ctx.lineTo(x, midY);
  ctx.closePath();
}

// -------------------- DRAW SHAPES --------------------

/**
 * Rectangle rendering with adaptive corner radius.
 *
 * Smaller shapes → smaller radius for better visual balance.
 */
function drawRectangle(
  ctx: CanvasRenderingContext2D,
  shape: Extract<Shape, { type: "rect" }>,
  viewportScale: number,
) {
  ctx.save();
  ctx.globalAlpha = getShapeOpacity(shape);

  const radius = Math.min(20, shape.width / 3, shape.height / 3);
  if (shouldUseRoughJs(shape)) {
    const rc = getRoughCanvas(ctx);
    if (rc) {
      if (shape.fill) {
        drawRoundedRect(
          ctx,
          shape.x,
          shape.y,
          shape.width,
          shape.height,
          radius,
        );
        applyShapeFill(ctx, shape);
      }
      rc.rectangle(
        shape.x,
        shape.y,
        shape.width,
        shape.height,
        getRoughOptions(shape, viewportScale),
      );
      ctx.restore();
      return;
    }
  }

  ctx.strokeStyle = shape.stroke || getThemePalette().stroke;
  ctx.lineWidth = getViewportAdjustedStrokeWidth(shape, viewportScale);
  applyStrokeStyle(ctx, shape, viewportScale);
  applyRoughness(ctx, shape);

  drawRoundedRect(ctx, shape.x, shape.y, shape.width, shape.height, radius);
  applyShapeFill(ctx, shape);
  ctx.stroke();
  ctx.restore();
}

/**
 * Ellipse rendering (supports both circle and oval).
 *
 * Uses center-based representation:
 * - centerX, centerY
 * - radiusX, radiusY
 */
function drawCircle(
  ctx: CanvasRenderingContext2D,
  shape: Extract<Shape, { type: "circle" }>,
  viewportScale: number,
) {
  ctx.save();
  ctx.globalAlpha = getShapeOpacity(shape);

  if (shouldUseRoughJs(shape)) {
    const rc = getRoughCanvas(ctx);
    if (rc) {
      if (shape.fill) {
        ctx.beginPath();
        ctx.ellipse(
          shape.centerX,
          shape.centerY,
          shape.radiusX,
          shape.radiusY,
          0,
          0,
          Math.PI * 2,
        );
        applyShapeFill(ctx, shape);
      }
      rc.ellipse(
        shape.centerX,
        shape.centerY,
        shape.radiusX * 2,
        shape.radiusY * 2,
        getRoughOptions(shape, viewportScale),
      );
      ctx.restore();
      return;
    }
  }

  ctx.strokeStyle = shape.stroke || getThemePalette().stroke;
  ctx.lineWidth = getViewportAdjustedStrokeWidth(shape, viewportScale);
  applyStrokeStyle(ctx, shape, viewportScale);
  applyRoughness(ctx, shape);

  ctx.beginPath();
  ctx.ellipse(
    shape.centerX,
    shape.centerY,
    shape.radiusX,
    shape.radiusY,
    0,
    0,
    Math.PI * 2,
  );
  applyShapeFill(ctx, shape);
  ctx.stroke();
  ctx.restore();
}

function drawRhombus(
  ctx: CanvasRenderingContext2D,
  shape: Extract<Shape, { type: "rhombus" }>,
  viewportScale: number,
) {
  ctx.save();
  ctx.globalAlpha = getShapeOpacity(shape);

  if (shouldUseRoughJs(shape)) {
    const rc = getRoughCanvas(ctx);
    if (rc) {
      if (shape.fill) {
        drawRhombusPath(ctx, shape.x, shape.y, shape.width, shape.height);
        applyShapeFill(ctx, shape);
      }

      const midX = shape.x + shape.width / 2;
      const midY = shape.y + shape.height / 2;
      rc.polygon(
        [
          [midX, shape.y],
          [shape.x + shape.width, midY],
          [midX, shape.y + shape.height],
          [shape.x, midY],
        ],
        getRoughOptions(shape, viewportScale),
      );
      ctx.restore();
      return;
    }
  }

  ctx.strokeStyle = shape.stroke || getThemePalette().stroke;
  ctx.lineWidth = getViewportAdjustedStrokeWidth(shape, viewportScale);
  applyStrokeStyle(ctx, shape, viewportScale);
  applyRoughness(ctx, shape);

  drawRhombusPath(ctx, shape.x, shape.y, shape.width, shape.height);
  applyShapeFill(ctx, shape);
  ctx.stroke();
  ctx.restore();
}

/**
 * Straight line between two points.
 *
 * Note:
 * Lines have no area → only stroke matters.
 */
function drawLine(
  ctx: CanvasRenderingContext2D,
  shape: Extract<Shape, { type: "line" }>,
  viewportScale: number,
) {
  ctx.save();
  ctx.globalAlpha = getShapeOpacity(shape);

  ctx.strokeStyle = shape.stroke || getThemePalette().stroke;
  ctx.lineWidth = getViewportAdjustedStrokeWidth(shape, viewportScale);
  applyStrokeStyle(ctx, shape, viewportScale);
  applyRoughness(ctx, shape);

  const routePoints = getConnectorRoutePoints(shape);

  ctx.beginPath();
  routePoints.forEach((point, index) => {
    if (index === 0) {
      ctx.moveTo(point.x, point.y);
      return;
    }

    ctx.lineTo(point.x, point.y);
  });
  ctx.stroke();
  ctx.restore();
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  shape: Extract<Shape, { type: "arrow" }>,
  viewportScale: number,
) {
  ctx.save();
  ctx.globalAlpha = getShapeOpacity(shape);
  const routePoints = getConnectorRoutePoints(shape);
  const arrowHead = getArrowHeadPoints(shape);
  if (!arrowHead) {
    ctx.restore();
    return;
  }

  ctx.strokeStyle = shape.stroke || getThemePalette().stroke;
  ctx.lineWidth = getViewportAdjustedStrokeWidth(shape, viewportScale);
  applyStrokeStyle(ctx, shape, viewportScale);
  applyRoughness(ctx, shape);

  ctx.beginPath();
  routePoints.forEach((point, index) => {
    if (index === 0) {
      ctx.moveTo(point.x, point.y);
      return;
    }

    ctx.lineTo(point.x, point.y);
  });
  ctx.moveTo(arrowHead.tip.x, arrowHead.tip.y);
  ctx.lineTo(arrowHead.left.x, arrowHead.left.y);
  ctx.moveTo(arrowHead.tip.x, arrowHead.tip.y);
  ctx.lineTo(arrowHead.right.x, arrowHead.right.y);
  ctx.stroke();
  ctx.restore();
}

function drawText(
  ctx: CanvasRenderingContext2D,
  shape: Extract<Shape, { type: "text" }>,
) {
  ctx.save();
  ctx.globalAlpha = getShapeOpacity(shape);
  // File intent: Use white text in dark mode for better contrast, otherwise use the shape's stroke color
  const isDarkMode = getThemePalette() === PAPER_DARK;
  ctx.fillStyle = isDarkMode
    ? "#efeadc"
    : shape.stroke || getThemePalette().stroke;
  const { fittedFontSize, lineHeight, visibleLines } = getTextRenderMetrics(
    ctx,
    shape,
  );
  ctx.font = `${fittedFontSize}px Virgil, Caveat, ui-rounded, sans-serif`;
  ctx.textBaseline = "top";

  visibleLines.forEach((line, index) => {
    const y = shape.y + index * lineHeight;
    ctx.fillText(line, shape.x, y);
  });
  ctx.restore();
}

function drawFreehand(
  ctx: CanvasRenderingContext2D,
  shape: Extract<Shape, { type: "freehand" }>,
  viewportScale: number,
) {
  if (shape.points.length < 2) return;

  ctx.save();
  ctx.strokeStyle = shape.stroke || getThemePalette().stroke;
  ctx.lineWidth = getViewportAdjustedStrokeWidth(shape, viewportScale);
  applyStrokeStyle(ctx, shape, viewportScale);
  ctx.globalAlpha = getShapeOpacity(shape);
  applyRoughness(ctx, shape);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.beginPath();
  ctx.moveTo(shape.points[0]!.x, shape.points[0]!.y);

  for (let i = 1; i < shape.points.length; i++) {
    const point = shape.points[i];
    if (!point) continue;
    ctx.lineTo(point.x, point.y);
  }

  ctx.stroke();
  ctx.restore();
}

function drawInfiniteGrid(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  viewport: Viewport,
  pixelRatio: number,
  gridColor: string,
) {
  // A dot grid reads as drafting paper and stays quiet behind content.
  const step = 24;
  const screenWidth = canvas.width / pixelRatio;
  const screenHeight = canvas.height / pixelRatio;
  const offsetX = ((viewport.x % step) + step) % step;
  const offsetY = ((viewport.y % step) + step) % step;

  ctx.save();
  ctx.fillStyle = gridColor;
  const size = 1.25;
  for (let x = offsetX; x <= screenWidth; x += step) {
    for (let y = offsetY; y <= screenHeight; y += step) {
      ctx.fillRect(Math.round(x) - size / 2, Math.round(y) - size / 2, size, size);
    }
  }
  ctx.restore();
}

// -------------------- BOUNDING BOX --------------------

/**
 * Computes the bounding box of a shape.
 *
 * Used for:
 * - selection outline
 * - resize handles
 *
 * Important:
 * Bounding box represents geometric limits,
 * NOT interaction logic.
 */
function getBoundingBox(shape: Shape, ctx?: CanvasRenderingContext2D) {
  if (shape.type === "rect") {
    return rectBounds(shape.x, shape.y, shape.width, shape.height);
  }

  if (shape.type === "circle") {
    const centerX = finiteOr(shape.centerX, 0);
    const centerY = finiteOr(shape.centerY, 0);
    const radiusX = Math.abs(finiteOr(shape.radiusX, 0));
    const radiusY = Math.abs(finiteOr(shape.radiusY, 0));
    return {
      x: centerX - radiusX,
      y: centerY - radiusY,
      width: radiusX * 2,
      height: radiusY * 2,
    };
  }

  if (shape.type === "rhombus") {
    return rectBounds(shape.x, shape.y, shape.width, shape.height);
  }

  if (shape.type === "line" || shape.type === "arrow") {
    const x = Math.min(shape.x1, shape.x2);
    const y = Math.min(shape.y1, shape.y2);
    const width = Math.abs(shape.x2 - shape.x1);
    const height = Math.abs(shape.y2 - shape.y1);

    return { x, y, width, height };
  }

  if (shape.type === "text") {
    if (ctx) {
      const { textWidth, textHeight } = getTextRenderMetrics(ctx, shape);
      return rectBounds(shape.x, shape.y, textWidth, textHeight);
    }

    return rectBounds(shape.x, shape.y, shape.width, shape.height);
  }

  if (shape.type === "freehand") {
    if (shape.points.length === 0) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }

    const xs = shape.points.map((point) => point.x);
    const ys = shape.points.map((point) => point.y);

    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  throw new Error("Unknown shape");
}

// -------------------- HANDLES --------------------

/**
 * Draws a resize handle.
 *
 * Handles are visual interaction points (corners of bounding box).
 */
function drawHandle(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.fillStyle = HANDLE_COLOR;
  ctx.strokeStyle = HANDLE_COLOR;

  ctx.beginPath();
  ctx.rect(x - HANDLE_SIZE / 2, y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
  ctx.fill();
}

// -------------------- HANDLE POSITIONS --------------------

/**
 * Returns corner positions for resize handles.
 *
 * padding → pushes handles slightly outward
 * inward tweak → fine visual alignment adjustment
 */
function getHandlePoints(shape: Shape, ctx: CanvasRenderingContext2D) {
  if (shape.type === "line" || shape.type === "arrow") {
    return [
      { x: shape.x1, y: shape.y1 },
      { x: shape.x2, y: shape.y2 },
    ];
  }

  const { x, y, width, height } = getBoundingBox(shape, ctx);
  const x1 = x - SELECTION_PADDING;
  const y1 = y - SELECTION_PADDING;
  const x2 = x + width + SELECTION_PADDING;
  const y2 = y + height + SELECTION_PADDING;
  const centerX = (x1 + x2) / 2;
  const centerY = (y1 + y2) / 2;

  return [
    { x: x1, y: y1 },
    { x: x2, y: y1 },
    { x: x1, y: y2 },
    { x: x2, y: y2 },
    { x: x1, y: centerY },
    { x: x2, y: centerY },
    { x: centerX, y: y1 },
    { x: centerX, y: y2 },
  ];
}

// -------------------- SELECTION --------------------

/**
 * Draws selection UI:
 * - bounding box (sharp)
 * - resize handles
 *
 * Purely visual (does not affect state).
 */
function drawSelection(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  viewport: Viewport,
  pixelRatio: number,
) {
  ctx.save();

  const { x, y, width, height } = getBoundingBox(shape, ctx);
  const topLeft = worldToScreenPoint({ x, y }, viewport);
  const bottomRight = worldToScreenPoint(
    { x: x + width, y: y + height },
    viewport,
  );
  const screenWidth = bottomRight.x - topLeft.x;
  const screenHeight = bottomRight.y - topLeft.y;

  ctx.strokeStyle = HANDLE_COLOR;
  ctx.lineWidth = 1;

  ctx.strokeRect(
    (topLeft.x - SELECTION_PADDING) * pixelRatio,
    (topLeft.y - SELECTION_PADDING) * pixelRatio,
    (screenWidth + SELECTION_PADDING * 2) * pixelRatio,
    (screenHeight + SELECTION_PADDING * 2) * pixelRatio,
  );

  const handles = getHandlePoints(shape, ctx);
  handles.forEach((p) => {
    const screenPoint = worldToScreenPoint(p, viewport);
    drawHandle(ctx, screenPoint.x * pixelRatio, screenPoint.y * pixelRatio);
  });

  ctx.restore();
}

function drawSelectionBox(
  ctx: CanvasRenderingContext2D,
  selectionBox: SelectionBox,
  viewport: Viewport,
  pixelRatio: number,
) {
  ctx.save();

  const start = worldToScreenPoint(
    { x: selectionBox.x, y: selectionBox.y },
    viewport,
  );
  const end = worldToScreenPoint(
    {
      x: selectionBox.x + selectionBox.width,
      y: selectionBox.y + selectionBox.height,
    },
    viewport,
  );
  const x = Math.min(start.x, end.x) * pixelRatio;
  const y = Math.min(start.y, end.y) * pixelRatio;
  const width = Math.abs(end.x - start.x) * pixelRatio;
  const height = Math.abs(end.y - start.y) * pixelRatio;

  ctx.strokeStyle = HANDLE_COLOR;
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 4]);

  ctx.strokeRect(x, y, width, height);

  ctx.restore();
}

function drawConnectorTargetHighlight(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  viewport: Viewport,
  pixelRatio: number,
) {
  if (shape.type === "line" || shape.type === "arrow") return;

  ctx.save();
  ctx.strokeStyle = CONNECTOR_TARGET_HIGHLIGHT_COLOR;
  ctx.lineWidth = 2.5;
  ctx.setLineDash([]);

  if (shape.type === "circle") {
    const center = worldToScreenPoint(
      { x: shape.centerX, y: shape.centerY },
      viewport,
    );
    const radiusX = shape.radiusX * viewport.scale * pixelRatio;
    const radiusY = shape.radiusY * viewport.scale * pixelRatio;

    ctx.beginPath();
    ctx.ellipse(
      center.x * pixelRatio,
      center.y * pixelRatio,
      radiusX,
      radiusY,
      0,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (shape.type === "rhombus") {
    const top = worldToScreenPoint(
      { x: shape.x + shape.width / 2, y: shape.y },
      viewport,
    );
    const right = worldToScreenPoint(
      { x: shape.x + shape.width, y: shape.y + shape.height / 2 },
      viewport,
    );
    const bottom = worldToScreenPoint(
      { x: shape.x + shape.width / 2, y: shape.y + shape.height },
      viewport,
    );
    const left = worldToScreenPoint(
      { x: shape.x, y: shape.y + shape.height / 2 },
      viewport,
    );

    ctx.beginPath();
    ctx.moveTo(top.x * pixelRatio, top.y * pixelRatio);
    ctx.lineTo(right.x * pixelRatio, right.y * pixelRatio);
    ctx.lineTo(bottom.x * pixelRatio, bottom.y * pixelRatio);
    ctx.lineTo(left.x * pixelRatio, left.y * pixelRatio);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
    return;
  }

  const box = getBoundingBox(shape, ctx);
  const topLeft = worldToScreenPoint({ x: box.x, y: box.y }, viewport);
  const bottomRight = worldToScreenPoint(
    { x: box.x + box.width, y: box.y + box.height },
    viewport,
  );

  const x = Math.min(topLeft.x, bottomRight.x) * pixelRatio;
  const y = Math.min(topLeft.y, bottomRight.y) * pixelRatio;
  const width = Math.abs(bottomRight.x - topLeft.x) * pixelRatio;
  const height = Math.abs(bottomRight.y - topLeft.y) * pixelRatio;

  ctx.strokeRect(x, y, width, height);
  ctx.restore();
}

// -------------------- RENDER --------------------

/**
 * Main render loop.
 *
 * Flow:
 * 1. Clear canvas (background fill)
 * 2. Draw all shapes
 * 3. Draw selection overlay
 *
 * Rendering is full redraw every frame (no retained state).
 */
export function render(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  shapes: Shape[],
  selectedShape: Shape | null,
  selectionBox: SelectionBox | null = null,
  selectedShapes: Shape[] = [],
  viewport: Viewport = DEFAULT_VIEWPORT,
  pixelRatio = 1,
  connectorTargetHighlightIds: string[] = [],
  showGrid = true,
  drawBackground = true,
) {
  const palette = getThemePalette();
  const canvasWidth = canvas.width / pixelRatio;
  const canvasHeight = canvas.height / pixelRatio;

  if (drawBackground) {
    ctx.save();
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.fillStyle = palette.background;

    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    if (showGrid) {
      drawInfiniteGrid(ctx, canvas, viewport, pixelRatio, palette.grid);
    }
    ctx.restore();
  }

  ctx.save();
  ctx.setTransform(
    viewport.scale * pixelRatio,
    0,
    0,
    viewport.scale * pixelRatio,
    viewport.x * pixelRatio,
    viewport.y * pixelRatio,
  );

  shapes.forEach((shape) => {
    const drawFn = drawMap[shape.type];
    if (!drawFn) return;

    // Each shape type has a specific draw function that handles its structure
    drawFn(ctx, shape as never, viewport.scale);
  });

  ctx.restore();

  if (connectorTargetHighlightIds.length > 0) {
    const highlightIds = new Set(connectorTargetHighlightIds);
    shapes.forEach((shape) => {
      if (!highlightIds.has(shape.id)) return;
      drawConnectorTargetHighlight(ctx, shape, viewport, pixelRatio);
    });
  }

  selectedShapes.forEach((shape) => {
    if (shape === selectedShape) return;
    drawSelection(ctx, shape, viewport, pixelRatio);
  });

  if (selectedShape) {
    const primary = shapes.find((shape) => shape.id === selectedShape.id);
    if (primary) {
      drawSelection(ctx, primary, viewport, pixelRatio);
    }
  }

  if (selectionBox) {
    drawSelectionBox(ctx, selectionBox, viewport, pixelRatio);
  }
}
