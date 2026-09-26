"use client";

import { useEffect, useRef } from "react";
import { convertToPoints, render, type Shape, type Viewport } from "@repo/canvas-engine";

type MinimapProps = {
  shapesRef: React.RefObject<Shape[]>;
  viewportRef: React.RefObject<Viewport | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Moves the main canvas (used when the user clicks/drags the minimap). */
  applyViewport: (viewport: Viewport) => void;
  isDark: boolean;
};

const WIDTH = 200;
const HEIGHT = 130;
const PADDING = 10;
const REFRESH_MS = 250;

/**
 * Small overview of the whole board with the current view outlined. Click or
 * drag on it to jump around — handy on big boards.
 */
export function Minimap({ shapesRef, viewportRef, canvasRef, applyViewport, isDark }: MinimapProps) {
  const miniRef = useRef<HTMLCanvasElement | null>(null);
  /** Mapping from the last draw, reused to translate pointer positions. */
  const mappingRef = useRef<{ minX: number; minY: number; scale: number } | null>(null);
  const lastKeyRef = useRef("");

  useEffect(() => {
    const draw = () => {
      const mini = miniRef.current;
      const main = canvasRef.current;
      const viewport = viewportRef.current;
      const shapes = shapesRef.current;
      if (!mini || !main || !viewport) return;

      // Skip work when nothing moved since the last frame.
      const key = `${shapes.length}:${shapes[shapes.length - 1]?.id ?? ""}:${viewport.x}:${viewport.y}:${viewport.scale}:${main.clientWidth}:${isDark}`;
      // Shapes can change in place (drag), so also fold in a cheap content signature.
      const signature = shapes.reduce((sum, shape) => {
        const box = convertToPoints(shape);
        return sum + box.x1 + box.y1 * 3 + box.x2 * 7 + box.y2 * 11;
      }, 0);
      const fullKey = `${key}:${Math.round(signature)}`;
      if (fullKey === lastKeyRef.current) return;
      lastKeyRef.current = fullKey;

      // World-space rectangle currently visible in the main canvas.
      const view = {
        x1: -viewport.x / viewport.scale,
        y1: -viewport.y / viewport.scale,
        x2: (main.clientWidth - viewport.x) / viewport.scale,
        y2: (main.clientHeight - viewport.y) / viewport.scale,
      };

      let minX = view.x1;
      let minY = view.y1;
      let maxX = view.x2;
      let maxY = view.y2;
      for (const shape of shapes) {
        const box = convertToPoints(shape);
        minX = Math.min(minX, box.x1);
        minY = Math.min(minY, box.y1);
        maxX = Math.max(maxX, box.x2);
        maxY = Math.max(maxY, box.y2);
      }

      const scale = Math.min(
        (WIDTH - PADDING * 2) / Math.max(1, maxX - minX),
        (HEIGHT - PADDING * 2) / Math.max(1, maxY - minY),
      );
      // Centre the content inside the minimap.
      const offsetX = (WIDTH - (maxX - minX) * scale) / 2;
      const offsetY = (HEIGHT - (maxY - minY) * scale) / 2;
      mappingRef.current = { minX: minX - offsetX / scale, minY: minY - offsetY / scale, scale };

      const dpr = window.devicePixelRatio || 1;
      if (mini.width !== WIDTH * dpr) {
        mini.width = WIDTH * dpr;
        mini.height = HEIGHT * dpr;
      }
      const ctx = mini.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, mini.width, mini.height);

      render(
        ctx,
        mini,
        shapes,
        null,
        null,
        [],
        { scale, x: -mappingRef.current.minX * scale, y: -mappingRef.current.minY * scale },
        dpr,
        [],
        false,
        false,
      );

      // Current view outline.
      const map = mappingRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.strokeStyle = "#3b82f6";
      ctx.fillStyle = "rgba(59,130,246,0.12)";
      ctx.lineWidth = 1.5;
      const rx = (view.x1 - map.minX) * scale;
      const ry = (view.y1 - map.minY) * scale;
      const rw = (view.x2 - view.x1) * scale;
      const rh = (view.y2 - view.y1) * scale;
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeRect(rx, ry, rw, rh);
    };

    draw();
    const timer = window.setInterval(draw, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [shapesRef, viewportRef, canvasRef, isDark]);

  const jumpTo = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const map = mappingRef.current;
    const main = canvasRef.current;
    const viewport = viewportRef.current;
    if (!map || !main || !viewport) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const worldX = map.minX + (event.clientX - rect.left) / map.scale;
    const worldY = map.minY + (event.clientY - rect.top) / map.scale;
    lastKeyRef.current = ""; // force a redraw so the outline follows immediately
    applyViewport({
      scale: viewport.scale,
      x: main.clientWidth / 2 - worldX * viewport.scale,
      y: main.clientHeight / 2 - worldY * viewport.scale,
    });
  };

  return (
    <div
      className={`pointer-events-auto absolute right-4 top-[4.75rem] z-20 hidden overflow-hidden rounded-xl border shadow-lg backdrop-blur-xl sm:block ${
        isDark ? "border-white/15 bg-[#171717]/80" : "border-slate-300 bg-white/80"
      }`}
      style={{ width: WIDTH, height: HEIGHT }}
    >
      <canvas
        ref={miniRef}
        aria-label="Board minimap"
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
