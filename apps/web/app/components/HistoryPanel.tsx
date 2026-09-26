"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { render, type CanvasState, type Shape, type Viewport } from "@repo/canvas-engine";
import { apiClient } from "../lib/apiClient";
import { HTTP_BACKEND } from "../../config";

type HistoryEntry = { id: number; shapeCount: number; createdAt: string };

type HistoryPanelProps = {
  roomId: number;
  canvasState: CanvasState | null;
  viewportRef: React.RefObject<Viewport | null>;
  isDark: boolean;
  onClose: () => void;
  onRestored: () => void;
  onError: (message: string) => void;
};

const PLAY_INTERVAL_MS = 900;

function formatWhen(iso: string) {
  const date = new Date(iso);
  const diffSec = Math.round((Date.now() - date.getTime()) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.round(diffSec / 60)} min ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)} h ago`;
  return date.toLocaleString();
}

/**
 * Time-travel over recorded room snapshots. The preview is drawn on its own
 * overlay canvas, so the live canvas (and realtime sync) is never touched
 * until the user explicitly restores a version.
 */
export function HistoryPanel({
  roomId,
  canvasState,
  viewportRef,
  isDark,
  onClose,
  onRestored,
  onError,
}: HistoryPanelProps) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  // Index into `entries` (oldest → newest); entries.length means "live".
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const cacheRef = useRef<Map<number, Shape[]>>(new Map());
  const [previewShapes, setPreviewShapes] = useState<Shape[] | null>(null);
  // Parents pass inline callbacks; keep them out of effect deps to avoid refetch loops.
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  // Load timeline (API returns newest first).
  useEffect(() => {
    let cancelled = false;
    apiClient
      .get(`${HTTP_BACKEND}/room/${roomId}/history`)
      .then((response) => {
        if (cancelled) return;
        const list = ((response.data?.data?.snapshots ?? []) as HistoryEntry[])
          .slice()
          .reverse();
        setEntries(list);
        setIndex(Math.max(0, list.length - 1));
      })
      .catch(() => {
        if (!cancelled) {
          setEntries([]);
          onErrorRef.current("Could not load version history.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  const liveIndex = entries?.length ?? 0;
  const selected = entries && index < liveIndex ? entries[index] : null;

  // Fetch (or reuse) the selected snapshot's shapes.
  useEffect(() => {
    if (!selected) {
      setPreviewShapes(null);
      return;
    }
    const cached = cacheRef.current.get(selected.id);
    if (cached) {
      setPreviewShapes(cached);
      return;
    }

    let cancelled = false;
    setLoadingSnapshot(true);
    apiClient
      .get(`${HTTP_BACKEND}/room/${roomId}/history/${selected.id}`)
      .then((response) => {
        if (cancelled) return;
        const shapes = (response.data?.data?.snapshot?.shapes ?? []) as Shape[];
        cacheRef.current.set(selected.id, shapes);
        setPreviewShapes(shapes);
      })
      .catch(() => {
        if (!cancelled) onErrorRef.current("Could not load that version.");
      })
      .finally(() => {
        if (!cancelled) setLoadingSnapshot(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, roomId]);

  // Draw the preview using the engine renderer at the live viewport.
  const draw = useCallback(() => {
    const canvas = overlayRef.current;
    if (!canvas || !previewShapes) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== Math.round(width * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const viewport = viewportRef.current ?? { x: width / 2, y: height / 2, scale: 1 };
    render(ctx, canvas, previewShapes, null, null, [], viewport, dpr);
  }, [previewShapes, viewportRef]);

  useEffect(() => {
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [draw]);

  // Auto-play through the timeline.
  useEffect(() => {
    if (!playing || !entries) return;
    const timer = window.setInterval(() => {
      setIndex((current) => {
        if (current >= entries.length - 1) {
          setPlaying(false);
          return entries.length - 1;
        }
        return current + 1;
      });
    }, PLAY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [playing, entries]);

  const step = useCallback(
    (delta: number) => {
      setPlaying(false);
      setIndex((current) => Math.min(liveIndex, Math.max(0, current + delta)));
    },
    [liveIndex],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowLeft") step(-1);
      else if (event.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, step]);

  const handleRestore = () => {
    if (!canvasState || !previewShapes) return;
    // Goes through the normal edit path, so it syncs to everyone and is undoable.
    canvasState.setShapes(previewShapes);
    onRestored();
    onClose();
  };

  const surface = isDark
    ? "border-white/15 bg-[#171717]/95 text-white/90"
    : "border-slate-300/80 bg-white/95 text-slate-800";
  const label = useMemo(() => {
    if (!entries) return "Loading history…";
    if (entries.length === 0) return "No versions recorded yet";
    if (!selected) return "Live canvas";
    return `${formatWhen(selected.createdAt)} · ${selected.shapeCount} shapes`;
  }, [entries, selected]);

  return (
    <>
      {selected && (
        <canvas
          ref={overlayRef}
          className="pointer-events-auto absolute inset-0 z-40 h-full w-full"
          aria-label="Version preview"
        />
      )}

      {selected && (
        <div className="pointer-events-none absolute left-1/2 top-4 z-50 -translate-x-1/2 rounded-full bg-amber-500 px-4 py-1.5 text-xs font-semibold text-white shadow-lg">
          Previewing an older version{loadingSnapshot ? " · loading…" : ""}
        </div>
      )}

      <div
        role="dialog"
        aria-label="Version history"
        className={`pointer-events-auto absolute bottom-4 left-1/2 z-50 w-[min(680px,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl border p-4 shadow-2xl backdrop-blur-2xl ${surface}`}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">Version history</div>
            <div className="text-xs opacity-70">{label}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-3 py-1 text-xs font-medium opacity-80 hover:opacity-100"
          >
            Close
          </button>
        </div>

        {entries && entries.length > 0 && (
          <>
            <input
              type="range"
              min={0}
              max={liveIndex}
              value={index}
              onChange={(event) => {
                setPlaying(false);
                setIndex(Number(event.target.value));
              }}
              className="w-full accent-blue-500"
              aria-label="Version timeline"
            />
            <div className="mt-1 flex justify-between text-[10px] opacity-60">
              <span>Oldest</span>
              <span>Live</span>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => step(-1)}
                disabled={index === 0}
                className="rounded-lg border border-current/20 px-3 py-1.5 text-xs disabled:opacity-40"
              >
                ← Prev
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!playing && index >= liveIndex - 1) setIndex(0);
                  setPlaying((value) => !value);
                }}
                className="rounded-lg border border-current/20 px-3 py-1.5 text-xs"
              >
                {playing ? "Pause" : "▶ Play timelapse"}
              </button>
              <button
                type="button"
                onClick={() => step(1)}
                disabled={index >= liveIndex}
                className="rounded-lg border border-current/20 px-3 py-1.5 text-xs disabled:opacity-40"
              >
                Next →
              </button>
              <button
                type="button"
                onClick={handleRestore}
                disabled={!selected || !previewShapes}
                className="ml-auto rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
              >
                Restore this version
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
