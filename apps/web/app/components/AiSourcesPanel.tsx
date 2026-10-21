"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Source {
  id: number;
  name: string;
  charCount: number;
}

interface AiSourcesPanelProps {
  roomId: number | null;
  isDark: boolean;
  httpBackend: string;
  apiClient: {
    post: (url: string, data?: unknown) => Promise<{ data: unknown }>;
    get: (url: string) => Promise<{ data: unknown }>;
    delete?: (url: string) => Promise<{ data: unknown }>;
  };
  /** Fill the chat input with a suggested question. */
  onPickQuestion: (question: string) => void;
}

const MAX_FILE_BYTES = 400_000;
const TEXT_FILE_PATTERN = /\.(txt|md|markdown|csv|json|log|html?|xml|ya?ml)$/i;

function errorMessage(error: unknown, fallback: string) {
  const e = error as { response?: { data?: { message?: string } } };
  return e.response?.data?.message || fallback;
}

export function AiSourcesPanel({
  roomId,
  isDark,
  httpBackend,
  apiClient,
  onPickQuestion,
}: AiSourcesPanelProps) {
  const [sources, setSources] = useState<Source[]>([]);
  const [open, setOpen] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [pasteName, setPasteName] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [questions, setQuestions] = useState<string[]>([]);
  const [loadingQuestions, setLoadingQuestions] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const base = roomId ? `${httpBackend}/room/${roomId}/sources` : null;

  const loadQuestions = useCallback(async () => {
    if (!base) return;
    setLoadingQuestions(true);
    try {
      const res = await apiClient.get(`${base}/suggestions`);
      setQuestions(
        (res.data as { data?: { questions?: string[] } })?.data?.questions ?? [],
      );
    } catch {
      setQuestions([]);
    } finally {
      setLoadingQuestions(false);
    }
  }, [apiClient, base]);

  // Reload when the canvas changes.
  useEffect(() => {
    setSources([]);
    setQuestions([]);
    if (!base) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiClient.get(base);
        const list =
          (res.data as { data?: { sources?: Source[] } })?.data?.sources ?? [];
        if (cancelled) return;
        setSources(list);
        if (list.length > 0) void loadQuestions();
      } catch {
        // Sources are optional; the chat works without them.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiClient, base, loadQuestions]);

  const addSource = async (name: string, text: string) => {
    if (!base) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiClient.post(base, { name, text });
      const source = (res.data as { data?: { source?: Source } })?.data?.source;
      if (source) setSources((prev) => [...prev, source]);
      setPasting(false);
      setPasteName("");
      setPasteText("");
      void loadQuestions();
    } catch (e) {
      setError(errorMessage(e, "Could not add source."));
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (file.size > MAX_FILE_BYTES) {
      setError("File is too large (max ~400 KB of text).");
      return;
    }
    if (!file.type.startsWith("text/") && !TEXT_FILE_PATTERN.test(file.name)) {
      setError("Only text files are supported (txt, md, csv, json…).");
      return;
    }
    await addSource(file.name, await file.text());
  };

  const removeSource = async (id: number) => {
    if (!base) return;
    const previous = sources;
    const next = sources.filter((s) => s.id !== id);
    setSources(next);
    try {
      await (apiClient.delete
        ? apiClient.delete(`${base}/${id}`)
        : Promise.reject(new Error("unsupported")));
      if (next.length === 0) setQuestions([]);
      else void loadQuestions();
    } catch {
      setSources(previous);
      setError("Could not remove source.");
    }
  };

  const text = isDark ? "text-white/70" : "text-slate-600";
  const muted = isDark ? "text-white/40" : "text-slate-400";
  const line = isDark ? "border-white/10" : "border-slate-200";
  const chip = isDark
    ? "border-indigo-400/30 bg-indigo-500/10 text-indigo-300 hover:bg-indigo-500/20"
    : "border-indigo-200 bg-indigo-50 text-indigo-600 hover:bg-indigo-100";
  const field = isDark
    ? "border-white/10 bg-white/6 text-white placeholder-white/30"
    : "border-slate-200 bg-white text-slate-900 placeholder-slate-400";

  return (
    <div className={`shrink-0 border-t px-3 py-2 text-[11px] ${line}`}>
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`flex items-center gap-1.5 font-medium ${text}`}
          aria-expanded={open}
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 2.5h6.5L13 6v7.5H3z M9.5 2.5V6H13" strokeLinejoin="round" />
          </svg>
          Sources{sources.length > 0 ? ` (${sources.length})` : ""}
          <span className={muted}>{open ? "▾" : "▸"}</span>
        </button>
        {open && (
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              className={`rounded-full border px-2 py-0.5 ${chip} disabled:opacity-40`}
            >
              Upload file
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setPasting((v) => !v)}
              className={`rounded-full border px-2 py-0.5 ${chip} disabled:opacity-40`}
            >
              Paste text
            </button>
          </div>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".txt,.md,.markdown,.csv,.json,.log,.html,.htm,.xml,.yml,.yaml,text/*"
        className="hidden"
        onChange={(e) => {
          void onFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {open && (
        <div className="mt-2 flex flex-col gap-1.5">
          {sources.length === 0 && !pasting && (
            <p className={muted}>
              Add notes, specs or docs. The AI uses them to suggest questions and
              ground the diagrams it draws.
            </p>
          )}
          {sources.map((s) => (
            <div key={s.id} className={`flex items-center justify-between gap-2 ${text}`}>
              <span className="truncate">
                {s.name} <span className={muted}>· {Math.max(1, Math.round(s.charCount / 1000))}k chars</span>
              </span>
              <button
                type="button"
                onClick={() => void removeSource(s.id)}
                aria-label={`Remove ${s.name}`}
                className={`${muted} hover:text-red-400`}
              >
                ✕
              </button>
            </div>
          ))}
          {pasting && (
            <div className="flex flex-col gap-1.5">
              <input
                value={pasteName}
                onChange={(e) => setPasteName(e.target.value)}
                placeholder="Name (e.g. Payments spec)"
                maxLength={120}
                className={`rounded-lg border px-2 py-1 outline-none ${field}`}
              />
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder="Paste text…"
                rows={4}
                className={`resize-none rounded-lg border px-2 py-1 outline-none ${field}`}
              />
              <button
                type="button"
                disabled={busy || pasteText.trim().length < 20}
                onClick={() => void addSource(pasteName.trim() || "Pasted text", pasteText)}
                className="self-end rounded-full bg-indigo-500 px-3 py-1 font-medium text-white disabled:opacity-40"
              >
                {busy ? "Indexing…" : "Add source"}
              </button>
            </div>
          )}
          {busy && !pasting && <p className={muted}>Indexing…</p>}
          {error && <p className="text-red-400">{error}</p>}
        </div>
      )}

      {sources.length > 0 && (loadingQuestions || questions.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className={muted}>Try:</span>
          {loadingQuestions && questions.length === 0 && (
            <span className={muted}>thinking of questions…</span>
          )}
          {questions.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => onPickQuestion(q)}
              title={q}
              className={`max-w-full truncate rounded-full border px-2.5 py-1 text-left ${chip}`}
            >
              {q}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
