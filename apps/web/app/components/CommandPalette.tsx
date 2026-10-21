"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type PaletteCommand = {
  id: string;
  label: string;
  group: string;
  hint?: string;
  keywords?: string;
  run: () => void;
};

/** In-order subsequence match with a bonus for word starts; null = no match. */
function score(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  const direct = t.indexOf(q);
  if (direct >= 0) return 100 - direct - (t.length - q.length) * 0.1;
  let ti = 0;
  let total = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return null;
    total += at === 0 || t[at - 1] === " " ? 3 : 1;
    ti = at + 1;
  }
  return total;
}

export function CommandPalette({
  open,
  onClose,
  commands,
  onAsk,
}: {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
  /** Hand free text to the assistant. */
  onAsk: (text: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const rows = useMemo(() => {
    const q = query.trim();
    const matched = commands
      .map((command) => {
        const s = score(q, `${command.label} ${command.keywords ?? ""}`);
        return s === null ? null : { command, s };
      })
      .filter((entry): entry is { command: PaletteCommand; s: number } => entry !== null)
      .sort((a, b) => b.s - a.s)
      .slice(0, 12)
      .map((entry) => ({ kind: "command" as const, command: entry.command }));
    if (!q) return matched;
    const ask = { kind: "ask" as const, text: q };
    // A clear command match wins. Otherwise sentences are almost certainly for the
    // assistant, while a single word is more likely a command the user is hunting for.
    const ql = q.toLowerCase();
    const clearMatch = matched.some((row) => row.command.label.toLowerCase().includes(ql));
    return !clearMatch && (q.includes(" ") || matched.length === 0)
      ? [ask, ...matched]
      : [...matched, ask];
  }, [commands, query]);

  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const run = (index: number) => {
    const row = rows[index];
    if (!row) return;
    onClose();
    if (row.kind === "ask") onAsk(row.text);
    else row.command.run();
  };

  let lastGroup = "";
  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-black/40 px-4 pt-[16vh]"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Command palette"
        className="w-full max-w-[34rem] overflow-hidden rounded-[10px] border border-rule-strong bg-surface text-ink shadow-[0_1px_0_var(--rule),0_40px_80px_-30px_rgba(0,0,0,0.7)]"
        style={{ fontFamily: "var(--font-ui)" }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((i) => (rows.length ? (i + 1) % rows.length : 0));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0));
            } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              run(active);
            }
          }}
          placeholder="Type a command, or ask anything…"
          aria-label="Command"
          className="block w-full border-b border-rule bg-transparent px-5 py-4 font-display text-[24px] tracking-tight text-ink outline-none placeholder:text-ink-3"
        />
        <div ref={listRef} role="listbox" className="max-h-[22rem] overflow-y-auto p-1.5">
          {rows.length === 0 && (
            <p className="px-3 py-6 text-center text-[13px] text-ink-3">Nothing matches.</p>
          )}
          {rows.map((row, index) => {
            const group = row.kind === "ask" ? "Assistant" : row.command.group;
            const header = group !== lastGroup;
            lastGroup = group;
            const selected = index === active;
            return (
              <div key={row.kind === "ask" ? "ask" : row.command.id}>
                {header && (
                  <p className="px-3 pb-1 pt-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-3">
                    {group}
                  </p>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-index={index}
                  onMouseMove={() => setActive(index)}
                  onClick={() => run(index)}
                  className={`flex w-full items-center justify-between gap-3 rounded-[6px] px-3 py-2 text-left text-[13.5px] ${
                    selected ? "bg-ink text-paper" : "text-ink"
                  }`}
                >
                  <span className="truncate">
                    {row.kind === "ask" ? (
                      <>
                        Ask or draw: <span className="font-display text-[16px] italic">“{row.text}”</span>
                      </>
                    ) : (
                      row.command.label
                    )}
                  </span>
                  {row.kind === "command" && row.command.hint && (
                    <span className={`shrink-0 font-mono text-[10.5px] ${selected ? "text-paper/60" : "text-ink-3"}`}>
                      {row.command.hint}
                    </span>
                  )}
                  {row.kind === "ask" && (
                    <span className={`shrink-0 font-mono text-[10.5px] ${selected ? "text-paper/60" : "text-ink-3"}`}>
                      ↵
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-4 border-t border-rule px-4 py-2 font-mono text-[10px] text-ink-3">
          <span>↑↓ move</span>
          <span>↵ run</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
