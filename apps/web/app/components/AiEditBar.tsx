"use client";

import { useEffect, useRef, useState } from "react";

type AiEditBarProps = {
  selectedCount: number;
  /** Selected freehand strokes that can be snapped to clean shapes. */
  sketchCount: number;
  onSnapSketches: () => void;
  isGenerating: boolean;
  isDark: boolean;
  onSubmit: (instruction: string) => void;
};

const SUGGESTIONS = [
  "Tidy up and align",
  "Make labels shorter",
  "Add error handling paths",
  "Translate to Hindi",
  "Recolor in a calm palette",
];

/**
 * Appears while shapes are selected: describe a change and the AI rewrites the
 * selection in place (instead of drawing something new next to it).
 */
export function AiEditBar({
  selectedCount,
  sketchCount,
  onSnapSketches,
  isGenerating,
  isDark,
  onSubmit,
}: AiEditBarProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Collapse when the selection goes away.
  useEffect(() => {
    if (selectedCount === 0) {
      setOpen(false);
      setText("");
    }
  }, [selectedCount]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (selectedCount === 0) return null;

  const surface = isDark
    ? "border-white/15 bg-[#171717]/92 text-white/90"
    : "border-slate-300/80 bg-white/92 text-slate-800";

  const submit = (instruction: string) => {
    const trimmed = instruction.trim();
    if (!trimmed || isGenerating) return;
    onSubmit(trimmed);
    setText("");
    setOpen(false);
  };

  return (
    <div className="pointer-events-none absolute bottom-24 left-1/2 z-30 -translate-x-1/2">
      {!open ? (
        <div className="pointer-events-auto flex items-center gap-2">
          {sketchCount > 0 && (
            <button
              type="button"
              onClick={onSnapSketches}
              className={`flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-semibold shadow-xl transition hover:brightness-110 ${surface}`}
              title="Replace rough strokes with clean rectangles, ellipses, diamonds, lines and arrows"
            >
              <span aria-hidden>⬚</span>
              Clean up {sketchCount === 1 ? "sketch" : `${sketchCount} sketches`}
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen(true)}
            disabled={isGenerating}
            className="flex items-center gap-2 rounded-full bg-linear-to-r from-violet-600 to-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-xl transition hover:brightness-110 disabled:opacity-60"
          >
            <span aria-hidden>✦</span>
            {isGenerating
              ? "AI is editing…"
              : `Edit ${selectedCount} selected with AI`}
          </button>
        </div>
      ) : (
        <div
          className={`pointer-events-auto w-[min(520px,calc(100vw-2rem))] rounded-2xl border p-3 shadow-2xl backdrop-blur-2xl ${surface}`}
        >
          <input
            ref={inputRef}
            value={text}
            maxLength={300}
            placeholder={`What should change in the ${selectedCount} selected shape${selectedCount === 1 ? "" : "s"}?`}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") submit(text);
              else if (event.key === "Escape") setOpen(false);
            }}
            className="w-full rounded-xl border border-current/15 bg-transparent px-3 py-2 text-sm outline-none"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => submit(suggestion)}
                className="rounded-full border border-current/15 px-2.5 py-1 text-[11px] opacity-80 transition hover:opacity-100"
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
