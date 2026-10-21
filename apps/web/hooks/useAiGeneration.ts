import { useState, useRef, useEffect, useCallback } from "react";

export interface ChatMessage {
  id: string;
  role: "user" | "ai";
  text: string;
  isGenerating?: boolean;
  isError?: boolean;
  shapeCount?: number;
  time: string;
  /** "ask" = text answer, "draw" = diagram (default). */
  kind?: "draw" | "ask";
  /** Draw replies keep the prompt that produced them, for Regenerate. */
  prompt?: string;
  citations?: AiCitation[];
}

export interface AiCitation {
  n: number;
  sourceName: string;
  snippet: string;
}

type HistoryTurn = { role: "user" | "ai"; text: string };

/** Present for edit-mode results: the shapes the AI output replaces. */
export interface AiResultMeta {
  replaceIds?: string[];
  /** Generated from an image: place beside existing content, not on top of it. */
  placeBeside?: boolean;
}

export type AiGenerateOptions =
  | {
      mode: "edit" | "summarize";
      selection: Array<Record<string, unknown> & { id: string }>;
    }
  | {
      mode: "image";
      image: { mimeType: "image/jpeg" | "image/png" | "image/webp"; data: string };
    };

interface UseAiGenerationOptions {
  roomId: number | null;
  /** Scopes the persisted chat history to this user (per user, per canvas). */
  userId?: string | null;
  httpBackend: string;
  apiClient: {
    post: (url: string, data?: unknown) => Promise<{ data: unknown }>;
    get: (url: string) => Promise<{ data: unknown }>;
    put: (url: string, data?: unknown) => Promise<{ data: unknown }>;
  };
  onShapesGenerated: (shapes: unknown[], meta?: AiResultMeta) => void;
  onError: (message: string) => void;
  /** Called with markdown when a "summarize" job finishes. */
  onSummary?: (summary: string) => void;
}

const POLL_INTERVAL_MS = 1500;
const POLL_MAX_ATTEMPTS = 100;
const SAVE_DEBOUNCE_MS = 800;
const HISTORY_TURNS = 6;

function nowTime() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function useAiGeneration({
  roomId,
  userId,
  httpBackend,
  apiClient,
  onShapesGenerated,
  onError,
  onSummary,
}: UseAiGenerationOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editTargetsRef = useRef<Map<string, string[]>>(new Map());
  const imageJobsRef = useRef<Set<string>>(new Set());

  // Chat lives on the server, private to this user on this canvas, so it follows
  // them across devices. Saving stays off until the first load succeeds so a
  // failed load can never overwrite stored history with an empty list.
  const chatKey = roomId && userId ? `${roomId}:${userId}` : null;
  const loadedKeyRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    loadedKeyRef.current = null;
    setMessages([]);
    if (!chatKey || !roomId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiClient.get(`${httpBackend}/room/${roomId}/ai/chat`);
        if (cancelled) return;
        const stored =
          (res.data as { data?: { messages?: ChatMessage[] } })?.data?.messages ?? [];
        setMessages(
          stored.map((m) =>
            m.isGenerating
              ? { ...m, isGenerating: false, isError: true, text: "Interrupted — please try again." }
              : m,
          ),
        );
        loadedKeyRef.current = chatKey;
      } catch {
        // Chat still works in-memory; it just won't persist this session.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiClient, chatKey, httpBackend, roomId]);

  useEffect(() => {
    if (!chatKey || !roomId || loadedKeyRef.current !== chatKey) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const settled = messages.filter((m) => !m.isGenerating).slice(-200);
      void apiClient
        .put(`${httpBackend}/room/${roomId}/ai/chat`, { messages: settled })
        .catch(() => undefined);
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [apiClient, chatKey, httpBackend, messages, roomId]);

  useEffect(
    () => () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    },
    [roomId],
  );

  const addMsg = useCallback((msg: ChatMessage) => setMessages((p) => [...p, msg]), []);
  const patchMsg = useCallback((id: string, patch: Partial<ChatMessage>) =>
    setMessages((p) => p.map((m) => (m.id === id ? { ...m, ...patch } : m))), []);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const getHistory = useCallback((): HistoryTurn[] => {
    return messagesRef.current
      .filter((m) => !m.isGenerating && !m.isError && m.text.trim())
      .slice(-HISTORY_TURNS)
      .map((m) => ({ role: m.role, text: m.text.slice(0, 500) }));
  }, []);

  const poll = useCallback((jobId: string, aiId: string, attempt = 0) => {
    if (!roomId) return;
    if (attempt > POLL_MAX_ATTEMPTS) {
      patchMsg(aiId, {
        isGenerating: false,
        isError: true,
        text: "Timed out — please try again.",
      });
      setIsGenerating(false);
      return;
    }
    pollTimerRef.current = setTimeout(async () => {
      try {
        const res = await apiClient.get(
          `${httpBackend}/room/${roomId}/ai/generate/${jobId}`,
        );
        const d = (
          res.data as {
            data?: {
              status?: string;
              shapes?: unknown[];
              summary?: string | null;
              errorMessage?: string;
            };
          }
        )?.data;
        if (d?.status === "done" && typeof d.summary === "string") {
          patchMsg(aiId, { isGenerating: false, text: "Summary ready." });
          onSummary?.(d.summary);
          setIsGenerating(false);
        } else if (d?.status === "done") {
          const shapes = d.shapes ?? [];
          const replaceIds = editTargetsRef.current.get(jobId);
          editTargetsRef.current.delete(jobId);
          const fromImage = imageJobsRef.current.delete(jobId);
          patchMsg(aiId, {
            isGenerating: false,
            shapeCount: shapes.length,
            text: replaceIds
              ? `Done! Updated your selection (${shapes.length} shapes).`
              : `Done! Added ${shapes.length} shapes to your canvas.`,
          });
          onShapesGenerated(
            shapes,
            replaceIds
              ? { replaceIds }
              : fromImage
                ? { placeBeside: true }
                : undefined,
          );
          setIsGenerating(false);
        } else if (d?.status === "error") {
          const msg = d.errorMessage ?? "Generation failed";
          patchMsg(aiId, { isGenerating: false, isError: true, text: msg });
          setIsGenerating(false);
          onError(msg);
        } else {
          poll(jobId, aiId, attempt + 1);
        }
      } catch {
        patchMsg(aiId, {
          isGenerating: false,
          isError: true,
          text: "Network error — please try again.",
        });
        setIsGenerating(false);
      }
    }, POLL_INTERVAL_MS);
  }, [apiClient, httpBackend, onError, onShapesGenerated, onSummary, patchMsg, roomId]);

  const generate = useCallback(async (
    prompt: string,
    displayText?: string,
    options?: AiGenerateOptions,
  ) => {
    if (!prompt.trim() || !roomId || isGenerating) return;

    const aid = `ai-${Date.now() + 1}`;
    addMsg({
      id: `u-${Date.now()}`,
      role: "user",
      text: displayText ?? prompt,
      time: nowTime(),
    });
    addMsg({
      id: aid,
      role: "ai",
      kind: "draw",
      prompt: options ? undefined : prompt,
      text:
        options?.mode === "summarize"
          ? "Summarizing…"
          : options
            ? "Editing…"
            : "Generating…",
      isGenerating: true,
      time: nowTime(),
    });
    setIsGenerating(true);

    try {
      const res = await apiClient.post(
        `${httpBackend}/room/${roomId}/ai/generate`,
        !options
          ? { prompt, history: getHistory() }
          : options.mode === "image"
            ? { prompt, mode: "image", image: options.image }
            : { prompt, mode: options.mode, selection: options.selection },
      );
      const jobId = (res.data as { data?: { jobId?: string } })?.data?.jobId;
      if (!jobId) throw new Error("No job ID");
      if (options?.mode === "edit") {
        editTargetsRef.current.set(
          jobId,
          options.selection.map((shape) => shape.id),
        );
      } else if (options?.mode === "image") {
        imageJobsRef.current.add(jobId);
      }
      poll(jobId, aid);
    } catch (error) {
      const maybeAxiosError = error as {
        response?: { data?: { message?: string } };
        message?: string;
      };
      const backendMessage =
        maybeAxiosError.response?.data?.message ||
        maybeAxiosError.message ||
        "Could not start AI generation.";
      patchMsg(aid, {
        isGenerating: false,
        isError: true,
        text: backendMessage,
      });
      setIsGenerating(false);
      onError(backendMessage);
    }
  }, [addMsg, apiClient, getHistory, httpBackend, isGenerating, onError, patchMsg, poll, roomId]);

  /** Text answer (no drawing), grounded in the canvas sources when there are any. */
  const ask = useCallback(
    async (question: string, board?: string) => {
      if (!question.trim() || !roomId || isGenerating) return;
      const history = getHistory();
      const aid = `ai-${Date.now() + 1}`;
      addMsg({ id: `u-${Date.now()}`, role: "user", text: question, kind: "ask", time: nowTime() });
      addMsg({ id: aid, role: "ai", text: "Thinking…", kind: "ask", isGenerating: true, time: nowTime() });
      setIsGenerating(true);
      try {
        const res = await apiClient.post(`${httpBackend}/room/${roomId}/ai/ask`, {
          question,
          history,
          ...(board ? { board } : {}),
        });
        const d = (res.data as { data?: { answer?: string; citations?: AiCitation[] } })?.data;
        patchMsg(aid, {
          isGenerating: false,
          text: d?.answer?.trim() || "I couldn't come up with an answer.",
          citations: d?.citations ?? [],
        });
      } catch (error) {
        const e = error as { response?: { data?: { message?: string } } };
        patchMsg(aid, {
          isGenerating: false,
          isError: true,
          text: e.response?.data?.message || "Could not get an answer. Please try again.",
        });
      } finally {
        setIsGenerating(false);
      }
    },
    [addMsg, apiClient, getHistory, httpBackend, isGenerating, patchMsg, roomId],
  );

  /** Re-run the draw prompt behind an AI reply. */
  const regenerate = useCallback(
    (messageId: string) => {
      const list = messagesRef.current;
      const idx = list.findIndex((m) => m.id === messageId);
      const prompt = idx >= 0 ? list[idx]?.prompt : undefined;
      if (!prompt) return;
      const userText = list[idx - 1]?.role === "user" ? list[idx - 1]!.text : undefined;
      void generate(prompt, userText);
    },
    [generate],
  );

  const clearHistory = useCallback(() => {
    setMessages([]);
  }, []);

  return {
    messages,
    isGenerating,
    generate,
    ask,
    regenerate,
    clearHistory,
  };
}
