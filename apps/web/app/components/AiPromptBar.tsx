"use client";

import { useState, useRef, useEffect, KeyboardEvent } from "react";
import { ChatMessage } from "../../hooks/useAiGeneration";
import { useAiSources } from "../../hooks/useAiSources";

interface AiChatModalProps {
  roomId: number | null;
  isOpen: boolean;
  onClose: () => void;
  isDark: boolean;
  httpBackend: string;
  apiClient: {
    post: (url: string, data?: unknown) => Promise<{ data: unknown }>;
    get: (url: string) => Promise<{ data: unknown }>;
    delete?: (url: string) => Promise<{ data: unknown }>;
  };
  getCurrentShapes: () => unknown[];
  // Props from useAiGeneration hook
  messages: ChatMessage[];
  isGenerating: boolean;
  onSend: (prompt: string, displayText?: string) => Promise<void>;
  onAsk: (question: string, board?: string) => Promise<void>;
  onRegenerate: (messageId: string) => void;
  /** An image dropped/picked in the chat: recreate it as shapes. */
  onImage: (file: File) => void;
  onClear: () => void;
}

type Intent = "draw" | "ask";

const DRAW_VERB =
  /^(please\s+)?(draw|sketch|diagram|map|create|make|build|generate|design|add|visuali[sz]e|illustrate|plot|show|compare|turn|convert|put|lay|lay out|chart|outline)\b/i;
const QUESTION_START =
  /^(what|why|how|who|whom|whose|when|where|which|is|are|was|were|do|does|did|can|could|should|would|will|explain|summari[sz]e|tell|describe|list|define|give me|suggest)\b/i;

/**
 * One input for everything: decide whether a message wants a drawing or a text
 * answer. "/draw" and "/ask" force it; otherwise lean on verbs and phrasing, and
 * default to drawing for bare noun phrases like "Microservices architecture".
 */
function detectIntent(text: string): { intent: Intent; text: string } {
  const forced = /^\/(draw|ask)\s+/i.exec(text);
  if (forced) {
    return {
      intent: forced[1]!.toLowerCase() as Intent,
      text: text.slice(forced[0].length).trim(),
    };
  }
  const t = text.trim();
  const isQuestion = t.endsWith("?");
  if (DRAW_VERB.test(t) && !(isQuestion && QUESTION_START.test(t))) {
    return { intent: "draw", text: t };
  }
  if (isQuestion || QUESTION_START.test(t)) return { intent: "ask", text: t };
  return { intent: "draw", text: t };
}

/** Plain text of labels on the board, so questions can reference what's drawn. */
function boardOutline(shapes: unknown[]): string {
  const labels: string[] = [];
  for (const shape of shapes) {
    const s = shape as { type?: string; text?: unknown };
    if (s.type === "text" && typeof s.text === "string" && s.text.trim()) {
      labels.push(s.text.trim().replace(/\s+/g, " "));
    }
  }
  return labels.join("\n").slice(0, 6000);
}

type Region = { minX: number; minY: number; maxX: number; maxY: number };

function asRegion(shape: unknown): Region | null {
  const s = shape as Record<string, unknown>;
  const type = s.type;

  // Accept precomputed occupancy region records directly.
  const minX = Number(s.minX);
  const minY = Number(s.minY);
  const maxX = Number(s.maxX);
  const maxY = Number(s.maxY);
  if ([minX, minY, maxX, maxY].every(Number.isFinite)) {
    return { minX, minY, maxX, maxY };
  }

  if (type === "rect" || type === "rhombus") {
    const x = Number(s.x);
    const y = Number(s.y);
    const w = Number(s.width);
    const h = Number(s.height);
    if ([x, y, w, h].some((v) => !Number.isFinite(v))) return null;
    return { minX: x, minY: y, maxX: x + w, maxY: y + h };
  }

  if (type === "circle") {
    const cx = Number(s.centerX);
    const cy = Number(s.centerY);
    const rx = Number(s.radiusX);
    const ry = Number(s.radiusY);
    if ([cx, cy, rx, ry].some((v) => !Number.isFinite(v))) return null;
    return { minX: cx - rx, minY: cy - ry, maxX: cx + rx, maxY: cy + ry };
  }

  if (type === "text") {
    const x = Number(s.x);
    const y = Number(s.y);
    const w = Number(s.width);
    const h = Number(s.height);
    if ([x, y].some((v) => !Number.isFinite(v))) return null;
    return {
      minX: x,
      minY: y,
      maxX: x + (Number.isFinite(w) && w > 0 ? w : 120),
      maxY: y + (Number.isFinite(h) && h > 0 ? h : 24),
    };
  }

  if (type === "line" || type === "arrow") {
    const x1 = Number(s.x1);
    const y1 = Number(s.y1);
    const x2 = Number(s.x2);
    const y2 = Number(s.y2);
    if ([x1, y1, x2, y2].some((v) => !Number.isFinite(v))) return null;
    return {
      minX: Math.min(x1, x2),
      minY: Math.min(y1, y2),
      maxX: Math.max(x1, x2),
      maxY: Math.max(y1, y2),
    };
  }

  return null;
}

function mergeRegions(regions: Region[], gap = 40): Region[] {
  if (regions.length <= 1) return regions;

  const sorted = [...regions].sort(
    (a, b) => a.minX - b.minX || a.minY - b.minY,
  );
  const merged: Region[] = [];

  for (const region of sorted) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push({ ...region });
      continue;
    }

    const overlapsOrNear = !(
      region.minX > last.maxX + gap ||
      region.maxX < last.minX - gap ||
      region.minY > last.maxY + gap ||
      region.maxY < last.minY - gap
    );

    if (overlapsOrNear) {
      last.minX = Math.min(last.minX, region.minX);
      last.minY = Math.min(last.minY, region.minY);
      last.maxX = Math.max(last.maxX, region.maxX);
      last.maxY = Math.max(last.maxY, region.maxY);
    } else {
      merged.push({ ...region });
    }
  }

  return merged;
}

function envelopeRegion(regions: Region[]): Region | null {
  if (regions.length === 0) return null;
  let minX = regions[0]!.minX;
  let minY = regions[0]!.minY;
  let maxX = regions[0]!.maxX;
  let maxY = regions[0]!.maxY;
  for (let i = 1; i < regions.length; i += 1) {
    const r = regions[i]!;
    minX = Math.min(minX, r.minX);
    minY = Math.min(minY, r.minY);
    maxX = Math.max(maxX, r.maxX);
    maxY = Math.max(maxY, r.maxY);
  }
  return { minX, minY, maxX, maxY };
}

// ─── AI Chat Modal ─────────────────────────────────────────────────────────────

const MAX_CANVAS_CONTEXT_CHARS = 8000;
const MAX_PROMPT_LENGTH = 12000;

export function AiChatModal({
  roomId,
  isOpen,
  onClose,
  isDark,
  httpBackend,
  apiClient,
  getCurrentShapes,
  messages,
  isGenerating,
  onSend,
  onAsk,
  onRegenerate,
  onImage,
  onClear,
}: AiChatModalProps) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const scrollEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const src = useAiSources(roomId, httpBackend, apiClient);

  /** Route picked/dropped files: images become diagrams, documents become sources. */
  const handleFiles = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (file.type.startsWith("image/")) onImage(file);
      else void src.addFile(file); // unsupported types surface a message
    }
  };

  useEffect(() => {
    if (isOpen) setTimeout(() => textareaRef.current?.focus(), 80);
  }, [isOpen]);
  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!isOpen) return;
    const h = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const h = (e: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node))
        onClose();
    };
    const id = setTimeout(() => document.addEventListener("pointerdown", h), 150);
    return () => {
      clearTimeout(id);
      document.removeEventListener("pointerdown", h);
    };
  }, [isOpen, onClose]);

  const handleSend = async () => {
    if (!input.trim() || !roomId || isGenerating) return;
    const text = input.trim();
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    const routed = detectIntent(text);
    if (!routed.text) return;
    const currentShapes = getCurrentShapes();
    if (routed.intent === "ask") {
      await onAsk(routed.text, boardOutline(currentShapes) || undefined);
      return;
    }
    await drawPrompt(routed.text, currentShapes);
  };

  /** Build the draw prompt (with free-space hints) and send it. */
  const drawPrompt = async (text: string, currentShapes: unknown[]) => {
    let finalPrompt = text;
    // Send large-area occupancy regions so backend can place new diagram in a truly empty zone.
    if (currentShapes.length > 0) {
      let regions = currentShapes
        .map(asRegion)
        .filter((r): r is Region => Boolean(r));

      regions = mergeRegions(regions, 44);
      let regionsJson = JSON.stringify(regions);

      if (regionsJson.length > MAX_CANVAS_CONTEXT_CHARS) {
        const envelope = envelopeRegion(regions);
        regions = envelope ? [envelope] : [];
        regionsJson = JSON.stringify(regions);
      }

      let candidatePrompt = `${text}\n\nCurrent canvas occupancy regions (${regions.length}):\n${regionsJson}`;
      while (candidatePrompt.length > MAX_PROMPT_LENGTH && regions.length > 1) {
        const envelope = envelopeRegion(regions);
        regions = envelope ? [envelope] : [];
        regionsJson = JSON.stringify(regions);
        candidatePrompt = `${text}\n\nCurrent canvas occupancy regions (${regions.length}):\n${regionsJson}`;
      }

      finalPrompt = candidatePrompt;
    }

    await onSend(finalPrompt, text);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  if (!isOpen) return null;

  const d = isDark;
  const surface = d ? "bg-[#12121c]" : "bg-white";
  const border = d ? "border-white/10" : "border-slate-200";
  const muted = d ? "text-white/45" : "text-slate-500";
  const faint = d ? "text-white/30" : "text-slate-400";
  const ghostBtn = d
    ? "text-white/60 hover:bg-white/10 hover:text-white"
    : "text-slate-500 hover:bg-slate-100 hover:text-slate-800";
  const chip = d
    ? "border-white/10 bg-white/5 text-white/75 hover:border-indigo-400/40 hover:bg-indigo-500/15 hover:text-white"
    : "border-slate-200 bg-white text-slate-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700";
  const aiBubble = d
    ? "bg-white/[0.06] text-white/90 ring-1 ring-white/10"
    : "bg-white text-slate-700 ring-1 ring-slate-200 shadow-sm";
  const sourceCount = src.sources.length;

  const quickPrompts = [
    { icon: "⎇", label: "User login flowchart" },
    { icon: "◫", label: "Microservices architecture" },
    { icon: "▤", label: "Database ERD for a blog" },
    { icon: "∞", label: "CI/CD pipeline diagram" },
  ];

  const pick = (text: string) => {
    setInput(text);
    setTimeout(() => textareaRef.current?.focus(), 30);
  };

  return (
    <div
      ref={panelRef}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        handleFiles(e.dataTransfer.files);
      }}
      className={`absolute right-0 top-14 z-50 flex w-[min(94vw,420px)] flex-col overflow-hidden rounded-3xl border shadow-[0_24px_70px_-12px_rgba(0,0,0,0.55)] ${surface} ${border}`}
      style={{ height: "min(640px, calc(100vh - 6rem))" }}
    >
      {/* ── Header ── */}
      <div className={`flex shrink-0 items-center gap-3 border-b px-4 py-3 ${border}`}>
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl text-sm text-white shadow-md"
          style={{ background: "linear-gradient(135deg,#6366f1,#a855f7)" }}
        >
          ✦
        </div>
        <div className="min-w-0 flex-1">
          <p className={`truncate text-sm font-semibold leading-tight ${d ? "text-white" : "text-slate-900"}`}>
            Canvas AI
          </p>
          <p className={`flex items-center gap-1.5 truncate text-[11px] leading-tight ${muted}`}>
            {isGenerating ? (
              <>
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                Working…
              </>
            ) : sourceCount > 0 ? (
              `Answers & diagrams · ${sourceCount} source${sourceCount > 1 ? "s" : ""}`
            ) : (
              "Answers & diagrams"
            )}
          </p>
        </div>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            disabled={isGenerating}
            title="Clear conversation"
            className={`grid h-8 w-8 place-items-center rounded-full transition disabled:opacity-40 ${ghostBtn}`}
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 6h12M8 6V4h4v2M6 6l.7 10h6.6L14 6" />
            </svg>
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          title="Close"
          className={`grid h-8 w-8 place-items-center rounded-full transition ${ghostBtn}`}
        >
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M5 5l10 10M15 5L5 15" />
          </svg>
        </button>
      </div>

      {/* ── Messages ── */}
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="flex flex-1 flex-col justify-center gap-5 py-2">
            <div className="text-center">
              <div
                className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl text-xl text-white shadow-lg"
                style={{ background: "linear-gradient(135deg,#6366f1,#a855f7)" }}
              >
                ✦
              </div>
              <p className={`text-[15px] font-semibold ${d ? "text-white" : "text-slate-900"}`}>
                What are we making?
              </p>
              <p className={`mx-auto mt-1 max-w-[280px] text-[12px] leading-relaxed ${muted}`}>
                Describe a diagram and I&apos;ll draw it, or ask a question. Add
                files with <span className="font-semibold">+</span> to ground the
                answers in your own material.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {quickPrompts.map((q) => (
                <button
                  key={q.label}
                  type="button"
                  onClick={() => pick(q.label)}
                  className={`flex items-center gap-2 rounded-2xl border px-3 py-2.5 text-left text-[12px] font-medium transition ${chip}`}
                >
                  <span className="text-base leading-none text-indigo-400">{q.icon}</span>
                  {q.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg, i) => {
            const isUser = msg.role === "user";
            const prevSame = i > 0 && messages[i - 1]?.role === msg.role;
            const isLast = i === messages.length - 1;
            return (
              <div
                key={msg.id}
                className={`flex flex-col ${isUser ? "items-end" : "items-start"} ${prevSame ? "mt-0.5" : "mt-3"}`}
              >
                <div
                  className={`max-w-[88%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed [overflow-wrap:anywhere] ${
                    isUser
                      ? "rounded-br-md text-white shadow-sm"
                      : msg.isError
                        ? d
                          ? "rounded-bl-md bg-red-500/12 text-red-300 ring-1 ring-red-400/25"
                          : "rounded-bl-md bg-red-50 text-red-700 ring-1 ring-red-200"
                        : `rounded-bl-md ${aiBubble}`
                  }`}
                  style={
                    isUser
                      ? { background: "linear-gradient(135deg,#6366f1,#7c3aed)" }
                      : undefined
                  }
                >
                  {msg.isGenerating ? (
                    <span className={`flex items-center gap-2.5 ${muted}`}>
                      <span className="flex gap-1">
                        {[0, 0.15, 0.3].map((delay) => (
                          <span
                            key={delay}
                            className="inline-block h-1.5 w-1.5 rounded-full bg-indigo-400"
                            style={{ animation: `bounce 0.8s ${delay}s ease-in-out infinite` }}
                          />
                        ))}
                      </span>
                      {msg.kind === "ask" ? "Thinking…" : msg.text}
                    </span>
                  ) : (
                    <>
                      {!isUser && !msg.isError && msg.shapeCount !== undefined && "✓ "}
                      {msg.text}
                    </>
                  )}
                </div>

                {msg.citations && msg.citations.length > 0 && (
                  <div className="mt-1.5 flex max-w-[92%] flex-wrap gap-1">
                    {msg.citations.map((c) => (
                      <span
                        key={c.n}
                        title={c.snippet}
                        className={`inline-flex max-w-full items-center gap-1 truncate rounded-full border px-2 py-0.5 text-[10px] ${chip}`}
                      >
                        <b className="text-indigo-400">{c.n}</b>
                        <span className="truncate">{c.sourceName}</span>
                      </span>
                    ))}
                  </div>
                )}

                {!isUser && isLast && !msg.isGenerating && !msg.isError && (
                  <div className="mt-1.5 flex gap-1.5">
                    {msg.kind === "ask" && messages[i - 1]?.role === "user" && (
                      <button
                        type="button"
                        disabled={isGenerating}
                        onClick={() =>
                          void drawPrompt(
                            detectIntent(messages[i - 1]!.text).text,
                            getCurrentShapes(),
                          )
                        }
                        className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition disabled:opacity-40 ${chip}`}
                      >
                        ✎ Draw this
                      </button>
                    )}
                    {msg.prompt && (
                      <button
                        type="button"
                        disabled={isGenerating}
                        onClick={() => onRegenerate(msg.id)}
                        className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition disabled:opacity-40 ${chip}`}
                      >
                        ↻ Regenerate
                      </button>
                    )}
                  </div>
                )}
                <span className={`mt-1 px-1 text-[10px] ${faint}`}>{msg.time}</span>
              </div>
            );
          })
        )}
        <div ref={scrollEndRef} />
      </div>

      {/* ── Suggested questions from the sources ── */}
      {sourceCount > 0 && (src.loadingQuestions || src.questions.length > 0) && (
        <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {src.loadingQuestions && src.questions.length === 0 && (
            <span className={`shrink-0 text-[11px] ${faint}`}>Thinking of ideas from your sources…</span>
          )}
          {src.questions.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => pick(q)}
              title={q}
              className={`max-w-[240px] shrink-0 truncate rounded-full border px-3 py-1 text-[11px] transition ${chip}`}
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {/* ── Composer ── */}
      <div className="shrink-0 px-3 pb-3">
        <div
          className={`rounded-2xl border transition-all focus-within:ring-2 ${
            d
              ? "border-white/10 bg-white/[0.05] focus-within:border-indigo-400/50 focus-within:ring-indigo-500/15"
              : "border-slate-200 bg-slate-50 focus-within:border-indigo-400 focus-within:ring-indigo-100"
          }`}
        >
          {(sourceCount > 0 || src.pending.length > 0) && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
              {src.sources.map((s) => (
                <span
                  key={s.id}
                  className={`group inline-flex max-w-[170px] items-center gap-1.5 rounded-lg border py-1 pl-2 pr-1 text-[11px] ${chip}`}
                  title={`${s.name} · ${Math.max(1, Math.round(s.charCount / 1000))}k chars`}
                >
                  <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0 text-indigo-400" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
                    <path d="M3.5 1.5h6L13 5v9.5H3.5z M9.5 1.5V5H13" />
                  </svg>
                  <span className="truncate">{s.name}</span>
                  <button
                    type="button"
                    onClick={() => void src.remove(s.id)}
                    aria-label={`Remove ${s.name}`}
                    className={`grid h-4 w-4 shrink-0 place-items-center rounded-full transition hover:bg-red-500/20 hover:text-red-400 ${faint}`}
                  >
                    ×
                  </button>
                </span>
              ))}
              {src.pending.map((name, idx) => (
                <span
                  key={`${name}-${idx}`}
                  className={`inline-flex max-w-[170px] items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] ${chip}`}
                >
                  <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-indigo-400/30 border-t-indigo-400" />
                  <span className="truncate">{name}</span>
                </span>
              ))}
            </div>
          )}
          {src.error && (
            <p className="px-3 pt-2 text-[11px] text-red-400">
              {src.error}{" "}
              <button type="button" onClick={src.clearError} className="underline">
                dismiss
              </button>
            </p>
          )}

          <textarea
            ref={textareaRef}
            id="ai-prompt-input"
            rows={1}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              const el = e.target;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
            }}
            onKeyDown={handleKeyDown}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length > 0) {
                e.preventDefault();
                handleFiles(files);
              }
            }}
            placeholder={isGenerating ? "Working…" : "Ask a question or describe a diagram…"}
            disabled={isGenerating}
            className={`block w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-[13px] outline-none disabled:opacity-40 ${
              d ? "text-white placeholder-white/30" : "text-slate-900 placeholder-slate-400"
            }`}
            style={{ minHeight: "28px", maxHeight: "120px" }}
          />

          <div className="relative flex items-center justify-between px-2 pb-2">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="Add files"
              aria-expanded={menuOpen}
              title="Add files or an image"
              className={`grid h-8 w-8 place-items-center rounded-full border transition ${
                menuOpen ? "border-indigo-400/50 bg-indigo-500/15 text-indigo-400" : `${border} ${ghostBtn}`
              }`}
            >
              <svg viewBox="0 0 20 20" className={`h-4 w-4 transition-transform ${menuOpen ? "rotate-45" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M10 4v12M4 10h12" />
              </svg>
            </button>

            {menuOpen && (
              <div
                className={`absolute bottom-11 left-1 z-10 w-60 overflow-hidden rounded-2xl border p-1 shadow-xl ${surface} ${border}`}
              >
                {[
                  {
                    label: "Upload documents",
                    hint: "PDF, Word, Excel, PowerPoint, text…",
                    run: () => fileInputRef.current?.click(),
                  },
                  {
                    label: "Use text on the board",
                    hint: "Save labels as a source",
                    run: () => {
                      const text = boardOutline(getCurrentShapes());
                      if (text.trim().length < 20) return;
                      void src.addText("Board text", text);
                    },
                  },
                  {
                    label: "Image to diagram",
                    hint: "Recreate a photo or screenshot",
                    run: () => {
                      const el = document.createElement("input");
                      el.type = "file";
                      el.accept = "image/*";
                      el.onchange = () => el.files?.[0] && onImage(el.files[0]);
                      el.click();
                    },
                  },
                ].map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      item.run();
                    }}
                    className={`flex w-full flex-col rounded-xl px-3 py-2 text-left transition ${
                      d ? "hover:bg-white/8" : "hover:bg-slate-100"
                    }`}
                  >
                    <span className={`text-[12px] font-medium ${d ? "text-white/90" : "text-slate-800"}`}>
                      {item.label}
                    </span>
                    <span className={`text-[10px] ${faint}`}>{item.hint}</span>
                  </button>
                ))}
              </div>
            )}

            <span className={`text-[10px] ${faint}`}>
              {input.trim() ? "Enter to send · Shift+Enter for newline" : "Drop files here · /draw or /ask to choose"}
            </span>

            <button
              id="ai-generate-button"
              type="button"
              onClick={() => void handleSend()}
              disabled={!input.trim() || !roomId || isGenerating}
              title="Send (Enter)"
              className="flex h-8 w-8 items-center justify-center rounded-full text-white shadow-sm transition-all enabled:hover:scale-105 disabled:cursor-not-allowed disabled:opacity-30"
              style={{ background: "linear-gradient(135deg,#6366f1,#a855f7)" }}
            >
              {isGenerating ? (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              ) : (
                <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 16V4M5 9l5-5 5 5" />
                </svg>
              )}
            </button>
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.xlsx,.pptx,.txt,.md,.markdown,.csv,.json,.log,.html,.htm,.xml,.yml,.yaml,text/*"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {/* ── Drop overlay ── */}
      {dragging && (
        <div
          className={`pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 border-2 border-dashed border-indigo-400/70 backdrop-blur-sm ${
            d ? "bg-[#12121c]/85" : "bg-white/85"
          }`}
        >
          <span className="text-3xl text-indigo-400">⇪</span>
          <p className={`text-sm font-semibold ${d ? "text-white" : "text-slate-800"}`}>Drop to add</p>
          <p className={`text-[11px] ${muted}`}>Documents become sources · images become diagrams</p>
        </div>
      )}
    </div>
  );
}

// ─── Trigger Button ────────────────────────────────────────────────────────────

interface AiTriggerButtonProps {
  onClick: () => void;
  isActive: boolean;
  isDark: boolean;
}

export function AiTriggerButton({
  onClick,
  isActive,
  isDark,
}: AiTriggerButtonProps) {
  return (
    <button
      id="ai-trigger-button"
      type="button"
      onClick={onClick}
      title="Generate with AI"
      className={`flex h-11 items-center gap-2 rounded-full border pl-3 pr-4 text-[13px] font-medium transition-all ${
        isActive
          ? isDark
            ? "border-indigo-400/50 bg-indigo-500/20 text-indigo-200"
            : "border-indigo-300 bg-indigo-50 text-indigo-700"
          : isDark
            ? "border-white/15 bg-[#191919]/95 text-white hover:border-indigo-400/30 hover:bg-[#1c1c2e]"
            : "border-slate-300 bg-white text-slate-700 hover:border-indigo-300 hover:bg-indigo-50/60"
      }`}
    >
      <span
        className="text-sm leading-none"
        style={
          !isActive
            ? {
                background: "linear-gradient(135deg,#6366f1,#8b5cf6)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }
            : undefined
        }
      >
        ✦
      </span>
      <span className="hidden sm:inline">Generate with AI</span>
      <span className="sm:hidden">AI</span>
    </button>
  );
}
