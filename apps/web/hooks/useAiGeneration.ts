import { useState, useRef, useEffect, useCallback } from "react";

export interface ChatMessage {
  id: string;
  role: "user" | "ai";
  text: string;
  isGenerating?: boolean;
  isError?: boolean;
  shapeCount?: number;
  time: string;
}

/** Present for edit-mode results: the shapes the AI output replaces. */
export interface AiResultMeta {
  replaceIds?: string[];
}

export interface AiGenerateOptions {
  mode: "edit";
  selection: Array<Record<string, unknown> & { id: string }>;
}

interface UseAiGenerationOptions {
  roomId: number | null;
  httpBackend: string;
  apiClient: {
    post: (url: string, data?: unknown) => Promise<{ data: unknown }>;
    get: (url: string) => Promise<{ data: unknown }>;
  };
  onShapesGenerated: (shapes: unknown[], meta?: AiResultMeta) => void;
  onError: (message: string) => void;
}

const POLL_INTERVAL_MS = 1500;
const POLL_MAX_ATTEMPTS = 40;
const AI_CHAT_STORAGE_KEY = "canvas-ai-chat-history";

function nowTime() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function useAiGeneration({
  roomId,
  httpBackend,
  apiClient,
  onShapesGenerated,
  onError,
}: UseAiGenerationOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editTargetsRef = useRef<Map<string, string[]>>(new Map());

  // Load messages from localStorage on mount
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(AI_CHAT_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as ChatMessage[];
        // Clear isGenerating flag on load since we don't resume polling across reloads yet
        const sanitized = parsed.map((m) =>
          m.isGenerating ? { ...m, isGenerating: false, text: "Interrupted — please try again." } : m,
        );
        setMessages(sanitized);
      }
    } catch {
      // Ignore parse errors
    }
  }, []);

  // Persist messages to localStorage whenever they change
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        AI_CHAT_STORAGE_KEY,
        JSON.stringify(messages),
      );
    } catch {
      // Ignore storage errors
    }
  }, [messages]);

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
              errorMessage?: string;
            };
          }
        )?.data;
        if (d?.status === "done") {
          const shapes = d.shapes ?? [];
          const replaceIds = editTargetsRef.current.get(jobId);
          editTargetsRef.current.delete(jobId);
          patchMsg(aiId, {
            isGenerating: false,
            shapeCount: shapes.length,
            text: replaceIds
              ? `Done! Updated your selection (${shapes.length} shapes).`
              : `Done! Added ${shapes.length} shapes to your canvas.`,
          });
          onShapesGenerated(shapes, replaceIds ? { replaceIds } : undefined);
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
  }, [apiClient, httpBackend, onError, onShapesGenerated, patchMsg, roomId]);

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
      text: options ? "Editing…" : "Generating…",
      isGenerating: true,
      time: nowTime(),
    });
    setIsGenerating(true);

    try {
      const res = await apiClient.post(
        `${httpBackend}/room/${roomId}/ai/generate`,
        options
          ? { prompt, mode: "edit", selection: options.selection }
          : { prompt },
      );
      const jobId = (res.data as { data?: { jobId?: string } })?.data?.jobId;
      if (!jobId) throw new Error("No job ID");
      if (options) {
        editTargetsRef.current.set(
          jobId,
          options.selection.map((shape) => shape.id),
        );
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
  }, [addMsg, apiClient, httpBackend, isGenerating, onError, patchMsg, poll, roomId]);

  const clearHistory = useCallback(() => {
    setMessages([]);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(AI_CHAT_STORAGE_KEY);
    }
  }, []);

  return {
    messages,
    isGenerating,
    generate,
    clearHistory,
  };
}
