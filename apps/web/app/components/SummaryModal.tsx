"use client";

import { useState } from "react";

type SummaryModalProps = {
  summary: string;
  isDark: boolean;
  onClose: () => void;
  onInsert: (text: string) => void;
};

function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
        part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
          <strong key={index}>{part.slice(2, -2)}</strong>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

/** Minimal renderer for the markdown subset the summary prompt produces. */
function SummaryBody({ text }: { text: string }) {
  return (
    <div className="space-y-1.5 text-sm leading-relaxed">
      {text.split("\n").map((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) return null;
        if (trimmed.startsWith("## ")) {
          return (
            <h3 key={index} className="pt-2 text-xs font-semibold uppercase tracking-wide opacity-60">
              {trimmed.slice(3)}
            </h3>
          );
        }
        const checkbox = /^- \[( |x)\]\s*(.*)$/i.exec(trimmed);
        if (checkbox) {
          return (
            <div key={index} className="flex gap-2">
              <span aria-hidden>{checkbox[1] === " " ? "☐" : "☑"}</span>
              <span><Inline text={checkbox[2] ?? ""} /></span>
            </div>
          );
        }
        if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
          return (
            <div key={index} className="flex gap-2">
              <span aria-hidden>•</span>
              <span><Inline text={trimmed.slice(2)} /></span>
            </div>
          );
        }
        return (
          <p key={index}>
            <Inline text={trimmed} />
          </p>
        );
      })}
    </div>
  );
}

export function SummaryModal({ summary, isDark, onClose, onInsert }: SummaryModalProps) {
  const [copied, setCopied] = useState(false);

  const surface = isDark
    ? "border-white/15 bg-[#171717] text-white/90"
    : "border-slate-300 bg-white text-slate-800";

  return (
    <div
      className="absolute inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Board summary"
        className={`max-h-[85vh] w-[min(600px,100%)] overflow-y-auto rounded-2xl border p-5 shadow-2xl ${surface}`}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") onClose();
        }}
      >
        <div className="mb-3 flex items-center gap-2 text-base font-semibold">
          <span aria-hidden>✦</span> Board summary
        </div>
        <SummaryBody text={summary} />
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-xs opacity-80 hover:opacity-100"
          >
            Close
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(summary);
                setCopied(true);
              } catch {
                // Clipboard can be unavailable (permissions, insecure context).
              }
            }}
            className="rounded-lg border border-current/20 px-3 py-1.5 text-xs"
          >
            {copied ? "Copied ✓" : "Copy markdown"}
          </button>
          <button
            type="button"
            onClick={() => onInsert(summary)}
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white"
          >
            Add as note on canvas
          </button>
        </div>
      </div>
    </div>
  );
}
