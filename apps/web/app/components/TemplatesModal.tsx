"use client";

import {
  Brain,
  GitBranch,
  Route,
  StickyNote,
  Target,
  Repeat,
  Columns3,
  type LucideIcon,
} from "lucide-react";
import { TEMPLATES, type TemplateId } from "@repo/canvas-engine";

const ICONS: Record<TemplateId, LucideIcon> = {
  sticky: StickyNote,
  kanban: Columns3,
  retro: Repeat,
  swot: Target,
  mindmap: Brain,
  journey: Route,
  flowchart: GitBranch,
};

type TemplatesModalProps = {
  isDark: boolean;
  onPick: (id: TemplateId) => void;
  onClose: () => void;
};

export function TemplatesModal({ onPick, onClose }: TemplatesModalProps) {
  const surface = "border-rule-strong bg-surface text-ink-2";
  const card = "border-rule bg-paper-2 hover:bg-paper-2";

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
              <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-signal-soft text-signal">
                {(() => {
                  const Icon = ICONS[template.id];
                  return <Icon className="h-5 w-5" aria-hidden />;
                })()}
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
