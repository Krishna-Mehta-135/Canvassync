"use client";

import { useState, useRef, useEffect, KeyboardEvent } from "react";
import { ChatMessage } from "../../hooks/useAiGeneration";
import { AiSourcesPanel } from "./AiSourcesPanel";

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
}

type Region = { minX: number; minY: number; maxX: number; maxY: number };

const EXAMPLES = [
  "User login flowchart",
  "Microservices architecture",
  "Database ERD for a blog",
  "CI/CD pipeline diagram",
];

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
}: AiChatModalProps) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const scrollEndRef = useRef<HTMLDivElement | null>(null);

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

    const currentShapes = getCurrentShapes();
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

  // Theme tokens
  const bg = isDark ? "bg-[#0f0f18]" : "bg-white";
  const border = isDark ? "border-white/10" : "border-slate-200";
  const subtext = isDark ? "text-white/40" : "text-slate-400";
  const headerBg = isDark
    ? "bg-gradient-to-r from-[#1a1740] to-[#1a1840]"
    : "bg-gradient-to-r from-indigo-50 to-violet-50";
  const headerTitle = isDark ? "text-white" : "text-indigo-900";
  const dividerBg = isDark ? "bg-white/8" : "bg-slate-100";
  const inputBg = isDark
    ? "bg-white/6 border-white/10 focus-within:border-indigo-400/40 focus-within:ring-indigo-500/10"
    : "bg-slate-50 border-slate-200 focus-within:border-indigo-400 focus-within:ring-indigo-100";
  const inputText = isDark
    ? "text-white placeholder-white/30"
    : "text-slate-900 placeholder-slate-400";
  const closeBtnCls = isDark
    ? "text-white/40 hover:bg-white/10 hover:text-white"
    : "text-slate-400 hover:bg-slate-100 hover:text-slate-700";
  const chipCls = isDark
    ? "border-indigo-400/30 bg-indigo-500/10 text-indigo-300 hover:bg-indigo-500/20"
    : "border-indigo-200 bg-indigo-50 text-indigo-600 hover:bg-indigo-100";
  const tipText = isDark ? "text-white/25" : "text-slate-400";
  const msgAreaBg = isDark ? "bg-[#0f0f18]" : "bg-slate-50/60";

  return (
    <div
      ref={panelRef}
      className={`absolute right-0 top-14 z-50 flex w-[min(94vw,390px)] flex-col rounded-2xl border shadow-2xl ${bg} ${border}`}
      style={{ maxHeight: "min(580px, calc(100vh - 6rem))" }}
    >
      {/* ── Header (chat app style) ── */}
      <div
        className={`flex shrink-0 items-center gap-3 rounded-t-2xl px-4 py-3 ${headerBg} border-b ${border}`}
      >
        {/* AI avatar */}
        <div
          className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm text-white shadow-sm"
          style={{ background: "linear-gradient(135deg,#6366f1,#8b5cf6)" }}
        >
          ✦
          <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p
            className={`text-sm font-semibold leading-tight truncate ${headerTitle}`}
          >
            Canvas AI
          </p>
          <div
            className={`text-[10px] leading-tight ${isDark ? "text-indigo-300/50" : "text-indigo-400"}`}
          >
            {isGenerating ? (
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 animate-pulse-scale rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]" />
                <span className="font-medium animate-pulse">Generating…</span>
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/50" />
                online
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs transition ${closeBtnCls}`}
        >
          ✕
        </button>
      </div>

      {/* ── Messages area ── */}
      <div
        className={`flex flex-1 flex-col gap-2 overflow-y-auto px-3 py-4 ${msgAreaBg}`}
      >
        {messages.length === 0 ? (
          /* Empty state */
          <div className="flex flex-col gap-3">
            {/* AI greeting bubble */}
            <div className="flex items-end gap-2">
              <div
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] text-white"
                style={{
                  background: "linear-gradient(135deg,#6366f1,#8b5cf6)",
                }}
              >
                ✦
              </div>
              <div
                className={`max-w-[88%] rounded-2xl rounded-bl-sm px-3.5 py-2.5 text-[13px] leading-relaxed ${isDark ? "bg-[#1e1e30] text-white/80" : "bg-white text-slate-700 shadow-sm border border-slate-100"}`}
              >
                Hi! Describe any diagram and I&apos;ll draw it on your canvas.
                Try an example below:
              </div>
            </div>
            <div className="ml-8 flex flex-wrap gap-1.5">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => {
                    setInput(ex);
                    setTimeout(() => textareaRef.current?.focus(), 50);
                  }}
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${chipCls}`}
                >
                  {ex}
                </button>
              ))}
            </div>
            <p className={`ml-8 mt-1 text-[11px] ${tipText}`}>
              You can also say &quot;improve colors&quot; or &quot;add a caching
              layer&quot; to modify existing shapes.
            </p>
          </div>
        ) : (
          messages.map((msg, i) => {
            const isUser = msg.role === "user";
            const prevSameRole = i > 0 && messages[i - 1]?.role === msg.role;
            return (
              <div
                key={msg.id}
                className={`flex items-end gap-2 ${isUser ? "flex-row-reverse" : "flex-row"} ${prevSameRole ? "mt-0.5" : "mt-2"}`}
              >
                {/* Avatar — only show on first of a group */}
                {!isUser && (
                  <div
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] text-white ${prevSameRole ? "invisible" : ""}`}
                    style={{
                      background: "linear-gradient(135deg,#6366f1,#8b5cf6)",
                    }}
                  >
                    ✦
                  </div>
                )}

                <div className="flex max-w-[82%] flex-col gap-0.5">
                  {/* Bubble */}
                  <div
                    className={`rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed ${
                      isUser
                        ? "rounded-br-sm bg-linear-to-br from-indigo-500 to-violet-600 text-white"
                        : msg.isGenerating
                          ? isDark
                            ? "rounded-bl-sm bg-[#1e1e30] text-white/60"
                            : "rounded-bl-sm bg-white text-slate-500 shadow-sm border border-slate-100"
                          : msg.isError
                            ? isDark
                              ? "rounded-bl-sm bg-red-500/15 text-red-300 border border-red-400/20"
                              : "rounded-bl-sm bg-red-50 text-red-700 border border-red-200"
                            : isDark
                              ? "rounded-bl-sm bg-emerald-500/12 text-emerald-200 border border-emerald-400/20"
                              : "rounded-bl-sm bg-white text-slate-700 shadow-sm border border-slate-100"
                    }`}
                  >
                    {msg.isGenerating ? (
                      <span className="flex items-center gap-3">
                        <span className="flex gap-1">
                          {[0, 0.15, 0.3].map((d) => (
                            <span
                              key={d}
                              className="inline-block h-2 w-2 rounded-full bg-indigo-400 shadow-[0_0_6px_rgba(129,140,248,0.4)]"
                              style={{
                                animation: `bounce 0.8s ${d}s ease-in-out infinite`,
                              }}
                            />
                          ))}
                        </span>
                        <span className="font-medium">Generating…</span>
                      </span>
                    ) : (
                      <span>
                        {!isUser &&
                          !msg.isError &&
                          msg.shapeCount !== undefined &&
                          "✓ "}
                        {!isUser && msg.isError && "⚠ "}
                        {msg.text}
                      </span>
                    )}
                  </div>
                  {/* Timestamp */}
                  <span
                    className={`px-1 text-[10px] ${isUser ? "text-right" : "text-left"} ${subtext}`}
                  >
                    {msg.time}
                  </span>
                </div>
              </div>
            );
          })
        )}
        <div ref={scrollEndRef} />
      </div>

      {/* ── Input bar ── */}
      <AiSourcesPanel
        roomId={roomId}
        isDark={isDark}
        httpBackend={httpBackend}
        apiClient={apiClient}
        onPickQuestion={(q) => {
          setInput(q);
          setTimeout(() => textareaRef.current?.focus(), 50);
        }}
      />

      <div
        className={`shrink-0 border-t px-3 pb-3 pt-2.5 ${dividerBg.replace("bg-", "border-")}`}
      >
        <div
          className={`flex items-end gap-2 rounded-2xl border px-3 py-2 transition-all focus-within:ring-2 ${inputBg}`}
        >
          <textarea
            ref={textareaRef}
            id="ai-prompt-input"
            rows={1}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              const el = e.target;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 88)}px`;
            }}
            onKeyDown={handleKeyDown}
            placeholder={isGenerating ? "Generating…" : "Ask Canvas AI…"}
            disabled={isGenerating}
            className={`flex-1 resize-none bg-transparent text-[13px] outline-none disabled:opacity-40 ${inputText}`}
            style={{ minHeight: "24px", maxHeight: "88px" }}
          />
          <button
            id="ai-generate-button"
            type="button"
            onClick={() => void handleSend()}
            disabled={!input.trim() || !roomId || isGenerating}
            title="Send (Enter)"
            className="mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white transition-all disabled:cursor-not-allowed disabled:opacity-25"
            style={{ background: "linear-gradient(135deg,#6366f1,#8b5cf6)" }}
          >
            {isGenerating ? (
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            ) : (
              <svg
                viewBox="0 0 20 20"
                className="h-3.5 w-3.5"
                fill="currentColor"
              >
                <path d="M3.5 2 L15.5 10 L3.5 18 Z" />
              </svg>
            )}
          </button>
        </div>
        <p className={`mt-1 text-center text-[10px] ${subtext}`}>
          Enter · Shift+Enter for newline
        </p>
      </div>
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
