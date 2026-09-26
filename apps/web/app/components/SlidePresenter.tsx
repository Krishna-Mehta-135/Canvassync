"use client";

import { useEffect, useState } from "react";
import type { Slide } from "./SlidesModal";

type SlidePresenterProps = {
  slides: Slide[];
  startIndex: number;
  isDark: boolean;
  goTo: (slide: Slide) => void;
  onExit: () => void;
};

/**
 * Presentation controls. Moving between slides moves the presenter's camera;
 * collaborators follow through the room's Present broadcast. Keys: → / Space /
 * PageDown next, ← / PageUp previous, Home / End, Esc to finish.
 */
export function SlidePresenter({ slides, startIndex, isDark, goTo, onExit }: SlidePresenterProps) {
  const [index, setIndex] = useState(startIndex);

  useEffect(() => {
    const slide = slides[index];
    if (slide) goTo(slide);
    // goTo is stable enough; re-running on every render would restart the animation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, slides]);

  // Best-effort fullscreen for a cleaner stage; ignore refusals.
  useEffect(() => {
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
    return () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    const last = slides.length - 1;
    const onKeyDown = (event: KeyboardEvent) => {
      const next = ["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"];
      const previous = ["ArrowLeft", "ArrowUp", "PageUp", "Backspace"];
      if (next.includes(event.key)) setIndex((current) => Math.min(last, current + 1));
      else if (previous.includes(event.key)) setIndex((current) => Math.max(0, current - 1));
      else if (event.key === "Home") setIndex(0);
      else if (event.key === "End") setIndex(last);
      else if (event.key === "Escape") onExit();
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [slides.length, onExit]);

  const slide = slides[index];
  if (!slide) return null;

  const surface = isDark
    ? "border-white/20 bg-black/75 text-white"
    : "border-slate-300 bg-white/90 text-slate-800";
  const button = "grid h-9 w-9 place-items-center rounded-full text-lg transition hover:bg-blue-500/25 disabled:opacity-30";

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-20 z-40 flex justify-center px-4">
      <div
        role="toolbar"
        aria-label="Slide controls"
        className={`pointer-events-auto flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 shadow-2xl backdrop-blur-xl ${surface}`}
      >
        <button type="button" className={button} disabled={index === 0} onClick={() => setIndex(index - 1)} aria-label="Previous slide">
          ‹
        </button>
        <div className="min-w-0 px-2 text-center">
          <div className="truncate text-sm font-semibold">{slide.title}</div>
          <div className="text-[11px] opacity-60">
            {index + 1} / {slides.length}
          </div>
        </div>
        <button
          type="button"
          className={button}
          disabled={index === slides.length - 1}
          onClick={() => setIndex(index + 1)}
          aria-label="Next slide"
        >
          ›
        </button>
        <button
          type="button"
          onClick={onExit}
          className="ml-1 rounded-full bg-rose-500 px-3 py-1 text-xs font-semibold text-white"
        >
          Exit
        </button>
      </div>
    </div>
  );
}
