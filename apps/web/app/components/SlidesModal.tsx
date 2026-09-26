"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "../lib/apiClient";
import { HTTP_BACKEND } from "../../config";

export type Slide = {
  id?: number;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type SlidesModalProps = {
  roomId: number;
  canEdit: boolean;
  isDark: boolean;
  /** The rectangle of canvas currently on screen. */
  getCurrentView: () => Omit<Slide, "title" | "id"> | null;
  /** Rectangle framing the selection (at the screen's aspect ratio), or null. */
  getSelectionFrame: () => Omit<Slide, "title" | "id"> | null;
  goTo: (slide: Slide) => void;
  onPresent: (slides: Slide[], startIndex: number) => void;
  onClose: () => void;
  onError: (message: string) => void;
};

const SAVE_DEBOUNCE_MS = 600;

/**
 * Slide deck manager. A slide is a saved rectangle of the infinite canvas;
 * presenting flies the camera from one to the next.
 */
export function SlidesModal({
  roomId,
  canEdit,
  isDark,
  getCurrentView,
  getSelectionFrame,
  goTo,
  onPresent,
  onClose,
  onError,
}: SlidesModalProps) {
  const [slides, setSlides] = useState<Slide[] | null>(null);
  const [saving, setSaving] = useState(false);
  const saveTimerRef = useRef<number | null>(null);
  const pendingSaveRef = useRef<Slide[] | null>(null);
  const loadedRef = useRef(false);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get(`${HTTP_BACKEND}/room/${roomId}/slides`)
      .then((response) => {
        if (cancelled) return;
        loadedRef.current = true;
        setSlides((response.data?.data?.slides ?? []) as Slide[]);
      })
      .catch(() => {
        if (!cancelled) {
          setSlides([]);
          onErrorRef.current("Could not load slides.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  const save = useCallback(
    async (next: Slide[]) => {
      setSaving(true);
      try {
        await apiClient.put(`${HTTP_BACKEND}/room/${roomId}/slides`, {
          slides: next.map(({ title, x, y, width, height }) => ({ title, x, y, width, height })),
        });
      } catch {
        onErrorRef.current("Couldn't save slides.");
      } finally {
        setSaving(false);
      }
    },
    [roomId],
  );

  const persist = useCallback(
    (next: Slide[]) => {
      if (!canEdit) return;
      pendingSaveRef.current = next;
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        const pending = pendingSaveRef.current;
        pendingSaveRef.current = null;
        if (pending) void save(pending);
      }, SAVE_DEBOUNCE_MS);
    },
    [canEdit, save],
  );

  // Closing the dialog must not drop an edit that is still waiting for its debounce.
  useEffect(
    () => () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      const pending = pendingSaveRef.current;
      pendingSaveRef.current = null;
      if (pending) void save(pending);
    },
    [save],
  );

  const update = (next: Slide[]) => {
    setSlides(next);
    persist(next);
  };

  const addSlide = (frame: Omit<Slide, "title" | "id"> | null) => {
    if (!frame || !slides) return;
    update([...slides, { title: `Slide ${slides.length + 1}`, ...frame }]);
  };

  const move = (index: number, delta: number) => {
    if (!slides) return;
    const target = index + delta;
    if (target < 0 || target >= slides.length) return;
    const next = [...slides];
    [next[index], next[target]] = [next[target]!, next[index]!];
    update(next);
  };

  const surface = isDark
    ? "border-white/15 bg-[#171717] text-white/90"
    : "border-slate-300 bg-white text-slate-800";
  const field = isDark ? "border-white/15 bg-black/30" : "border-slate-300 bg-slate-50";
  const iconButton =
    "grid h-7 w-7 place-items-center rounded-md text-xs hover:bg-blue-500/20 disabled:opacity-30 disabled:hover:bg-transparent";

  const selectionFrame = getSelectionFrame();

  return (
    <div
      className="absolute inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Slides"
        className={`max-h-[85vh] w-[min(560px,100%)] overflow-y-auto rounded-2xl border p-5 shadow-2xl ${surface}`}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") onClose();
        }}
      >
        <div className="mb-1 flex items-center justify-between">
          <div className="text-base font-semibold">Slides</div>
          {saving && <span className="text-[11px] opacity-60">Saving…</span>}
        </div>
        <p className="mb-4 text-xs opacity-70">
          A slide is a saved view of your canvas. Present them in order — everyone in the room follows along
          live. Nothing is recorded.
        </p>

        {canEdit && (
          <div className="mb-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => addSlide(getCurrentView())}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white"
            >
              + Add current view
            </button>
            <button
              type="button"
              disabled={!selectionFrame}
              onClick={() => addSlide(selectionFrame)}
              className="rounded-lg border border-current/20 px-3 py-1.5 text-xs disabled:opacity-40"
              title={selectionFrame ? "Frame the selected shapes" : "Select shapes first"}
            >
              + Frame selection
            </button>
          </div>
        )}

        {slides === null && <p className="text-sm opacity-70">Loading…</p>}
        {slides && slides.length === 0 && (
          <p className="text-sm opacity-70">
            {canEdit
              ? "No slides yet. Pan and zoom to what you want to show, then add it."
              : "No slides in this room yet."}
          </p>
        )}

        <ol className="space-y-2">
          {slides?.map((slide, index) => (
            <li
              key={`${slide.id ?? "new"}-${index}`}
              className="flex items-center gap-2 rounded-xl border border-current/10 px-2 py-1.5"
            >
              <span className="w-6 text-center text-xs font-semibold opacity-60">{index + 1}</span>
              <input
                value={slide.title}
                readOnly={!canEdit}
                maxLength={80}
                onChange={(event) =>
                  update(slides.map((item, i) => (i === index ? { ...item, title: event.target.value } : item)))
                }
                onBlur={() => {
                  if (slide.title.trim() === "") {
                    update(slides.map((item, i) => (i === index ? { ...item, title: `Slide ${index + 1}` } : item)));
                  }
                }}
                aria-label={`Title of slide ${index + 1}`}
                className={`min-w-0 flex-1 rounded-md border px-2 py-1 text-sm outline-none ${field}`}
              />
              <button type="button" onClick={() => goTo(slide)} className={iconButton} title="Go to this slide" aria-label="Go to slide">
                ◎
              </button>
              {canEdit && (
                <>
                  <button type="button" disabled={index === 0} onClick={() => move(index, -1)} className={iconButton} aria-label="Move up">
                    ↑
                  </button>
                  <button type="button" disabled={index === slides.length - 1} onClick={() => move(index, 1)} className={iconButton} aria-label="Move down">
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => update(slides.filter((_, i) => i !== index))}
                    className={`${iconButton} text-red-500`}
                    aria-label="Delete slide"
                  >
                    ✕
                  </button>
                </>
              )}
            </li>
          ))}
        </ol>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs opacity-80 hover:opacity-100">
            Close
          </button>
          <button
            type="button"
            disabled={!slides || slides.length === 0}
            onClick={() => slides && onPresent(slides, 0)}
            className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
          >
            ▶ Present slides
          </button>
        </div>
      </div>
    </div>
  );
}
