"use client";

import { useMemo, useState } from "react";
import { shapesToMermaid, type Shape } from "@repo/canvas-engine";

type MermaidModalProps = {
  mode: "import" | "export";
  isDark: boolean;
  /** Import: returns an error message, or null when the diagram was inserted. */
  onImport: (source: string) => string | null;
  /** Export: the shapes to convert (selection, or the whole canvas). */
  shapes: Shape[];
  scopeLabel: string;
  onClose: () => void;
  onCopied: () => void;
};

const SAMPLE = `flowchart TD
  A[Client] -->|HTTPS| B{API Gateway}
  B --> C[Auth Service]
  B --> D[Orders Service]
  D --> E((Cache))
  D -.-> F[(Database)]`;

export function MermaidModal({
  mode,
  isDark,
  onImport,
  shapes,
  scopeLabel,
  onClose,
  onCopied,
}: MermaidModalProps) {
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);

  const exported = useMemo(
    () => (mode === "export" ? shapesToMermaid(shapes) : null),
    [mode, shapes],
  );

  const surface = isDark
    ? "border-white/15 bg-[#171717] text-white/90"
    : "border-slate-300 bg-white text-slate-800";
  const field = isDark
    ? "border-white/15 bg-black/30"
    : "border-slate-300 bg-slate-50";

  const copy = async () => {
    if (!exported) return;
    try {
      await navigator.clipboard.writeText(exported.code);
      onCopied();
    } catch {
      setError("Copy failed — select the text and copy it manually.");
    }
  };

  return (
    <div
      className="absolute inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label={mode === "import" ? "Import Mermaid" : "Export Mermaid"}
        className={`w-[min(640px,100%)] rounded-2xl border p-5 shadow-2xl ${surface}`}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") onClose();
        }}
      >
        <div className="mb-1 text-base font-semibold">
          {mode === "import" ? "Import Mermaid diagram" : "Copy as Mermaid"}
        </div>
        <p className="mb-3 text-xs opacity-70">
          {mode === "import"
            ? "Paste a Mermaid flowchart. It becomes editable shapes, auto-laid-out in the middle of your view."
            : `Flowchart of ${scopeLabel}. Only connectors attached to shapes on both ends are included.`}
        </p>

        {mode === "import" ? (
          <textarea
            autoFocus
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              setError(null);
            }}
            placeholder={SAMPLE}
            spellCheck={false}
            className={`h-56 w-full resize-none rounded-xl border p-3 font-mono text-xs outline-none ${field}`}
          />
        ) : (
          <textarea
            readOnly
            value={exported?.code ?? ""}
            className={`h-56 w-full resize-none rounded-xl border p-3 font-mono text-xs outline-none ${field}`}
          />
        )}

        {mode === "export" && exported && (
          <p className="mt-2 text-xs opacity-70">
            {exported.nodeCount} nodes, {exported.edgeCount} edges
            {exported.skippedConnectors > 0
              ? ` · ${exported.skippedConnectors} unattached connector(s) skipped`
              : ""}
          </p>
        )}
        {error && <p className="mt-2 text-xs text-red-500">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          {mode === "import" && (
            <button
              type="button"
              onClick={() => setSource(SAMPLE)}
              className="mr-auto rounded-lg px-3 py-1.5 text-xs opacity-70 hover:opacity-100"
            >
              Use sample
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-xs opacity-80 hover:opacity-100"
          >
            Cancel
          </button>
          {mode === "import" ? (
            <button
              type="button"
              disabled={source.trim().length === 0}
              onClick={() => {
                const message = onImport(source);
                if (message) setError(message);
              }}
              className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
            >
              Insert on canvas
            </button>
          ) : (
            <button
              type="button"
              disabled={!exported || exported.nodeCount === 0}
              onClick={() => void copy()}
              className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
            >
              Copy to clipboard
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
