"use client";

import { useEffect, useRef, useState } from "react";
import { apiClient } from "../lib/apiClient";
import { HTTP_BACKEND } from "../../config";

type ThumbShape = Record<string, unknown> & { type?: string };

const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

function bounds(shapes: ThumbShape[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const s of shapes) {
    switch (s.type) {
      case "rect":
      case "rhombus":
      case "text":
        grow(num(s.x), num(s.y));
        grow(num(s.x) + num(s.width), num(s.y) + num(s.height));
        break;
      case "circle":
        grow(num(s.centerX) - num(s.radiusX), num(s.centerY) - num(s.radiusY));
        grow(num(s.centerX) + num(s.radiusX), num(s.centerY) + num(s.radiusY));
        break;
      case "line":
      case "arrow":
        grow(num(s.x1), num(s.y1));
        grow(num(s.x2), num(s.y2));
        break;
      case "freehand":
        for (const p of (s.points as Array<{ x: number; y: number }>) ?? []) grow(num(p.x), num(p.y));
        break;
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** A small static SVG of a room's contents, fetched only once the card scrolls into view. */
export function RoomThumbnail({ roomId }: { roomId: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shapes, setShapes] = useState<ThumbShape[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        apiClient
          .get(`${HTTP_BACKEND}/room/${roomId}/shapes`)
          .then((res) => {
            if (cancelled) return;
            const raw = res.data?.data;
            const list = Array.isArray(raw) ? raw : raw?.shapes;
            setShapes(Array.isArray(list) ? (list as ThumbShape[]).slice(0, 400) : []);
          })
          .catch(() => !cancelled && setFailed(true));
      },
      { rootMargin: "120px" },
    );
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [roomId]);

  const box = shapes ? bounds(shapes) : null;
  const pad = 40;
  const view = box
    ? `${box.minX - pad} ${box.minY - pad} ${Math.max(60, box.maxX - box.minX + pad * 2)} ${Math.max(60, box.maxY - box.minY + pad * 2)}`
    : "0 0 1 1";
  const ink = "var(--ink-2)";
  const strokeW = box ? Math.max(1.5, (box.maxX - box.minX) / 140) : 2;

  return (
    <div
      ref={ref}
      className="relative aspect-[16/10] overflow-hidden border-b border-rule bg-paper"
      style={{
        backgroundImage: "radial-gradient(var(--rule-strong) 1px, transparent 1.1px)",
        backgroundSize: "16px 16px",
      }}
    >
      {box && shapes && (
        <svg viewBox={view} preserveAspectRatio="xMidYMid meet" className="absolute inset-0 h-full w-full" aria-hidden="true">
          {shapes.map((s, i) => {
            const fill = typeof s.fill === "string" && s.fill !== "transparent" ? s.fill : "none";
            const stroke = typeof s.stroke === "string" ? s.stroke : ink;
            switch (s.type) {
              case "rect":
                return <rect key={i} x={num(s.x)} y={num(s.y)} width={num(s.width)} height={num(s.height)} rx={6} fill={fill} fillOpacity={0.85} stroke={stroke} strokeWidth={strokeW} />;
              case "rhombus": {
                const x = num(s.x), y = num(s.y), w = num(s.width), h = num(s.height);
                return <polygon key={i} points={`${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`} fill={fill} fillOpacity={0.85} stroke={stroke} strokeWidth={strokeW} />;
              }
              case "circle":
                return <ellipse key={i} cx={num(s.centerX)} cy={num(s.centerY)} rx={num(s.radiusX)} ry={num(s.radiusY)} fill={fill} fillOpacity={0.85} stroke={stroke} strokeWidth={strokeW} />;
              case "line":
              case "arrow":
                return <line key={i} x1={num(s.x1)} y1={num(s.y1)} x2={num(s.x2)} y2={num(s.y2)} stroke={ink} strokeOpacity={0.6} strokeWidth={strokeW} />;
              case "freehand": {
                const pts = ((s.points as Array<{ x: number; y: number }>) ?? []).filter((_, n) => n % 2 === 0);
                return <polyline key={i} points={pts.map((p) => `${num(p.x)},${num(p.y)}`).join(" ")} fill="none" stroke={stroke} strokeWidth={strokeW} strokeLinejoin="round" />;
              }
              case "text":
                return (
                  <rect key={i} x={num(s.x)} y={num(s.y) + num(s.height) * 0.35} width={Math.min(num(s.width), String(s.text ?? "").length * 8)} height={Math.max(3, num(s.height) * 0.22)} rx={2} fill={ink} fillOpacity={0.35} />
                );
              default:
                return null;
            }
          })}
        </svg>
      )}
      {shapes && !box && (
        <p className="absolute inset-0 grid place-items-center font-display text-[22px] italic text-ink-3">Empty</p>
      )}
      {failed && <p className="absolute inset-0 grid place-items-center font-mono text-[10.5px] text-ink-3">No preview</p>}
    </div>
  );
}
