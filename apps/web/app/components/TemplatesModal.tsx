"use client";

import { TEMPLATES, type TemplateId } from "@repo/canvas-engine";

type TemplatesModalProps = {
  isDark: boolean;
  onPick: (id: TemplateId) => void;
  onClose: () => void;
};

export function TemplatesModal({ isDark, onPick, onClose }: TemplatesModalProps) {
  const surface = isDark
    ? "border-white/15 bg-[#171717] text-white/90"
    : "border-slate-300 bg-white text-slate-800";
  const card = isDark
    ? "border-white/10 bg-white/5 hover:bg-white/10"
    : "border-slate-200 bg-slate-50 hover:bg-slate-100";

  return (
    <div
      className="absolute inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Templates"
        className={`max-h-[85vh] w-[min(680px,100%)] overflow-y-auto rounded-2xl border p-5 shadow-2xl ${surface}`}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") onClose();
        }}
      >
        <div className="mb-1 text-base font-semibold">Templates &amp; sticky notes</div>
        <p className="mb-4 text-xs opacity-70">
          Dropped into the middle of your view. Everything stays editable — it&apos;s
          just shapes and text.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              onClick={() => onPick(template.id)}
              className={`flex items-start gap-3 rounded-xl border p-3 text-left transition ${card}`}
            >
              <span className="text-2xl" aria-hidden>
                {template.emoji}
              </span>
              <span>
                <span className="block text-sm font-semibold">{template.name}</span>
                <span className="block text-xs opacity-70">{template.description}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-xs opacity-80 hover:opacity-100"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
