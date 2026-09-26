"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { convertToPoints, render, type Shape, type Viewport } from "@repo/canvas-engine";
import { HTTP_BACKEND } from "../../../config";

type PublicBoard = {
  room: { slug: string; ownerName: string; ownerHandle: string | null };
  shapes: Shape[];
};

const POLL_MS = 15_000;
const MIN_SCALE = 0.05;
const MAX_SCALE = 8;

function fitViewport(shapes: Shape[], width: number, height: number): Viewport {
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
  const padding = 100;
  const scale = Math.min(
    1.5,
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

/** Read-only, unauthenticated board viewer reached through a public share link. */
export default function PublicBoardPage() {
  const { token } = useParams<{ token: string }>();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const shapesRef = useRef<Shape[]>([]);
  const viewportRef = useRef<Viewport>({ x: 0, y: 0, scale: 1 });
  const hasFittedRef = useRef(false);
  const lastPayloadRef = useRef("");
  const rafRef = useRef<number | null>(null);

  const [board, setBoard] = useState<PublicBoard | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "error">("loading");

  const draw = useCallback(() => {
    rafRef.current = null;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    render(ctx, canvas, shapesRef.current, null, null, [], viewportRef.current, dpr);
  }, []);

  const scheduleDraw = useCallback(() => {
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(draw);
  }, [draw]);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${HTTP_BACKEND}/public/board/${encodeURIComponent(token)}`);
      if (response.status === 404) {
        setStatus("missing");
        return;
      }
      if (!response.ok) throw new Error(String(response.status));
      const payload = (await response.json()) as { data?: PublicBoard };
      if (!payload.data) throw new Error("empty");

      const serialized = JSON.stringify(payload.data.shapes);
      if (serialized === lastPayloadRef.current) return;
      lastPayloadRef.current = serialized;

      shapesRef.current = payload.data.shapes;
      setBoard(payload.data);
      setStatus("ready");

      const canvas = canvasRef.current;
      if (canvas && !hasFittedRef.current) {
        hasFittedRef.current = true;
        viewportRef.current = fitViewport(payload.data.shapes, canvas.clientWidth, canvas.clientHeight);
      }
      scheduleDraw();
    } catch {
      setStatus((current) => (current === "ready" ? current : "error"));
    }
  }, [token, scheduleDraw]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  // Pan (drag), zoom (wheel / pinch gesture) and resize.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let dragging: { x: number; y: number } | null = null;

    const onPointerDown = (event: PointerEvent) => {
      dragging = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      viewportRef.current = {
        ...viewportRef.current,
        x: viewportRef.current.x + event.clientX - dragging.x,
        y: viewportRef.current.y + event.clientY - dragging.y,
      };
      dragging = { x: event.clientX, y: event.clientY };
      scheduleDraw();
    };
    const onPointerUp = () => {
      dragging = null;
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const current = viewportRef.current;

      if (event.ctrlKey || event.metaKey || Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor));
        const worldX = (px - current.x) / current.scale;
        const worldY = (py - current.y) / current.scale;
        viewportRef.current = { scale, x: px - worldX * scale, y: py - worldY * scale };
      } else {
        viewportRef.current = { ...current, x: current.x - event.deltaX, y: current.y - event.deltaY };
      }
      scheduleDraw();
    };
    const onResize = () => scheduleDraw();

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("resize", onResize);
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", onResize);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [scheduleDraw]);

  const zoomBy = (factor: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const current = viewportRef.current;
    const cx = canvas.clientWidth / 2;
    const cy = canvas.clientHeight / 2;
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor));
    const worldX = (cx - current.x) / current.scale;
    const worldY = (cy - current.y) / current.scale;
    viewportRef.current = { scale, x: cx - worldX * scale, y: cy - worldY * scale };
    scheduleDraw();
  };

  const fit = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    viewportRef.current = fitViewport(shapesRef.current, canvas.clientWidth, canvas.clientHeight);
    scheduleDraw();
  };

  const chip =
    "rounded-full border border-white/15 bg-black/60 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-xl";

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#0b1020]">
      <canvas ref={canvasRef} className="block h-full w-full touch-none cursor-grab active:cursor-grabbing" />

      {status === "ready" && board && (
        <>
          <div className={`absolute left-4 top-4 ${chip}`}>
            <span className="font-semibold">{board.room.slug}</span>
            <span className="opacity-70"> · by {board.room.ownerName} · view only</span>
          </div>
          <div className="absolute bottom-4 left-4 flex items-center gap-2">
            <button type="button" onClick={() => zoomBy(1 / 1.25)} className={chip} aria-label="Zoom out">−</button>
            <button type="button" onClick={() => zoomBy(1.25)} className={chip} aria-label="Zoom in">+</button>
            <button type="button" onClick={fit} className={chip}>Fit</button>
          </div>
          <a
            href="/"
            className={`absolute bottom-4 right-4 ${chip} no-underline`}
            target="_blank"
            rel="noreferrer"
          >
            Made with Canvas.io
          </a>
        </>
      )}

      {status !== "ready" && (
        <div className="absolute inset-0 grid place-items-center text-center text-white/80">
          <div>
            <div className="text-lg font-semibold">
              {status === "loading" && "Loading board…"}
              {status === "missing" && "This link isn’t active"}
              {status === "error" && "Couldn’t load the board"}
            </div>
            {status === "missing" && (
              <p className="mt-1 text-sm opacity-70">
                The owner may have turned off or replaced the public link.
              </p>
            )}
            {status === "error" && (
              <button type="button" onClick={() => void load()} className={`mt-3 ${chip}`}>
                Try again
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
