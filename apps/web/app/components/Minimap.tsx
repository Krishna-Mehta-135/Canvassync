"use client";

import { useEffect, useRef } from "react";
import { convertToPoints, type Shape, type Viewport } from "@repo/canvas-engine";

type MinimapProps = {
  shapesRef: React.RefObject<Shape[]>;
  viewportRef: React.RefObject<Viewport | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Moves the main canvas (used when the user clicks/drags the minimap). */
  applyViewport: (viewport: Viewport) => void;
  isDark: boolean;
};

const WIDTH = 208;
const HEIGHT = 136;
const PADDING = 12;
/** Extra world space kept around the content so the view can drift a little without rescaling. */
const MARGIN_RATIO = 0.2;
const SHAPES_CHECK_MS = 200;

type Mapping = { minX: number; minY: number; scale: number };

const FALLBACK_COLOR = "#94a3b8";

function shapeColor(shape: Shape) {
  return shape.stroke && shape.stroke !== "transparent" ? shape.stroke : FALLBACK_COLOR;
}

/** Cheap signature: changes whenever a shape is added, removed, moved or resized. */
function signatureOf(shapes: Shape[]) {
  let sum = shapes.length;
  for (const shape of shapes) {
    const box = convertToPoints(shape);
    sum += box.x1 * 1.3 + box.y1 * 2.1 + box.x2 * 3.7 + box.y2 * 5.9;
  }
  return Math.round(sum * 10);
}

function computeMapping(shapes: Shape[], view: { x1: number; y1: number; x2: number; y2: number }): Mapping {
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
  // Empty board: frame the current view.
  if (!Number.isFinite(minX)) {
    minX = view.x1;
    minY = view.y1;
    maxX = view.x2;
    maxY = view.y2;
  }

  const marginX = Math.max(200, (maxX - minX) * MARGIN_RATIO);
  const marginY = Math.max(140, (maxY - minY) * MARGIN_RATIO);
  minX -= marginX;
  maxX += marginX;
  minY -= marginY;
  maxY += marginY;

  const scale = Math.min(
    (WIDTH - PADDING * 2) / Math.max(1, maxX - minX),
    (HEIGHT - PADDING * 2) / Math.max(1, maxY - minY),
  );
  return {
    scale,
    minX: minX - (WIDTH / scale - (maxX - minX)) / 2,
    minY: minY - (HEIGHT / scale - (maxY - minY)) / 2,
  };
}

/** Flat, low-detail drawing of the board (fast, and easy to read at thumbnail size). */
function drawShapes(ctx: CanvasRenderingContext2D, shapes: Shape[], map: Mapping) {
  const toX = (x: number) => (x - map.minX) * map.scale;
  const toY = (y: number) => (y - map.minY) * map.scale;

  for (const shape of shapes) {
    const color = shapeColor(shape);

    if (shape.type === "line" || shape.type === "arrow") {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(toX(shape.x1), toY(shape.y1));
      ctx.lineTo(toX(shape.x2), toY(shape.y2));
      ctx.stroke();
      continue;
    }

    if (shape.type === "freehand") {
      if (shape.points.length < 2) continue;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1;
      ctx.beginPath();
      shape.points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(toX(point.x), toY(point.y));
        else ctx.lineTo(toX(point.x), toY(point.y));
      });
      ctx.stroke();
      continue;
    }

    const box = convertToPoints(shape);
    const x = toX(box.x1);
    const y = toY(box.y1);
    const w = Math.max(1.5, (box.x2 - box.x1) * map.scale);
    const h = Math.max(1.5, (box.y2 - box.y1) * map.scale);

    if (shape.type === "text") {
      // Text reads as a thin bar so titles and labels keep their place.
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.5;
      ctx.fillRect(x, y + h / 2 - 0.75, w, 1.5);
      continue;
    }

    ctx.fillStyle = color;
    ctx.globalAlpha = 0.28;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (shape.type === "circle") {
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    } else if (shape.type === "rhombus") {
      ctx.moveTo(x + w / 2, y);
      ctx.lineTo(x + w, y + h / 2);
      ctx.lineTo(x + w / 2, y + h);
      ctx.lineTo(x, y + h / 2);
      ctx.closePath();
    } else {
      ctx.rect(x, y, w, h);
    }
    ctx.fill();
    ctx.globalAlpha = 0.8;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/**
 * Overview of the whole board with the current view outlined. Click or drag to
 * move around.
 *
 * Smoothness: the board itself is drawn to an offscreen canvas only when the
 * shapes change, and the mapping is derived from the shapes (not the camera),
 * so panning never forces a re-layout. Each animation frame just blits that
 * cache and draws the view rectangle.
 */
export function Minimap({ shapesRef, viewportRef, canvasRef, applyViewport, isDark }: MinimapProps) {
  const miniRef = useRef<HTMLCanvasElement | null>(null);
  const mappingRef = useRef<Mapping | null>(null);

  useEffect(() => {
    const mini = miniRef.current;
    if (!mini) return;

    const dpr = window.devicePixelRatio || 1;
    mini.width = WIDTH * dpr;
    mini.height = HEIGHT * dpr;
    const ctx = mini.getContext("2d");
    if (!ctx) return;

    const layer = document.createElement("canvas");
    layer.width = WIDTH * dpr;
    layer.height = HEIGHT * dpr;
    const layerCtx = layer.getContext("2d");
    if (!layerCtx) return;

    let lastSignature = "";
    let lastCheck = 0;
    let raf = 0;

    const currentView = () => {
      const viewport = viewportRef.current;
      const main = canvasRef.current;
      if (!viewport || !main) return null;
      return {
        x1: -viewport.x / viewport.scale,
        y1: -viewport.y / viewport.scale,
        x2: (main.clientWidth - viewport.x) / viewport.scale,
        y2: (main.clientHeight - viewport.y) / viewport.scale,
      };
    };

    const rebuildLayer = (shapes: Shape[], view: NonNullable<ReturnType<typeof currentView>>) => {
      mappingRef.current = computeMapping(shapes, view);
      layerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      layerCtx.clearRect(0, 0, WIDTH, HEIGHT);
      drawShapes(layerCtx, shapes, mappingRef.current);
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const view = currentView();
      if (!view) return;

      // Re-check the shapes a few times per second, not every frame.
      if (now - lastCheck > SHAPES_CHECK_MS || !mappingRef.current) {
        lastCheck = now;
        const shapes = shapesRef.current ?? [];
        const signature = `${signatureOf(shapes)}:${isDark}`;
        if (signature !== lastSignature || !mappingRef.current) {
          lastSignature = signature;
          rebuildLayer(shapes, view);
        }
      }

      const map = mappingRef.current;
      if (!map) return;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, mini.width, mini.height);
      ctx.drawImage(layer, 0, 0);

      // The view rectangle, clipped to the minimap.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const rx = (view.x1 - map.minX) * map.scale;
      const ry = (view.y1 - map.minY) * map.scale;
      const rw = (view.x2 - view.x1) * map.scale;
      const rh = (view.y2 - view.y1) * map.scale;

      ctx.save();
      ctx.beginPath();
      ctx.rect(1, 1, WIDTH - 2, HEIGHT - 2);
      ctx.clip();
      // Dim everything outside the view so the visible area stands out.
      ctx.fillStyle = isDark ? "rgba(2,6,23,0.45)" : "rgba(15,23,42,0.10)";
      ctx.beginPath();
      ctx.rect(0, 0, WIDTH, HEIGHT);
      ctx.rect(rx, ry, rw, rh);
      ctx.fill("evenodd");
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(rx + 0.75, ry + 0.75, Math.max(2, rw - 1.5), Math.max(2, rh - 1.5));
      ctx.restore();
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [shapesRef, viewportRef, canvasRef, isDark]);

  const jumpTo = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const map = mappingRef.current;
    const main = canvasRef.current;
    const viewport = viewportRef.current;
    if (!map || !main || !viewport) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const worldX = map.minX + (event.clientX - rect.left) / map.scale;
    const worldY = map.minY + (event.clientY - rect.top) / map.scale;
    applyViewport({
      scale: viewport.scale,
      x: main.clientWidth / 2 - worldX * viewport.scale,
      y: main.clientHeight / 2 - worldY * viewport.scale,
    });
  };

  return (
    <div
      className={`pointer-events-auto absolute right-4 top-[4.75rem] z-20 hidden overflow-hidden rounded-xl border shadow-lg backdrop-blur-xl sm:block ${
        isDark
          ? "border-white/10 bg-[#0f172a]/80 shadow-black/40"
          : "border-slate-200 bg-white/85 shadow-slate-300/40"
      }`}
      style={{ width: WIDTH, height: HEIGHT }}
    >
      <canvas
        ref={miniRef}
        aria-label="Board overview. Click or drag to move around."
        className="block cursor-crosshair touch-none"
        style={{ width: WIDTH, height: HEIGHT }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          jumpTo(event);
        }}
        onPointerMove={(event) => {
          if (event.buttons === 1) jumpTo(event);
        }}
      />
    </div>
  );
}
