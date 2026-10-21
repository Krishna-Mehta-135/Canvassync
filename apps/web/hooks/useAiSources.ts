"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  extractDocumentText,
  isOfficeFile,
  MAX_OFFICE_FILE_BYTES,
  MAX_PDF_FILE_BYTES,
  UnsafeArchiveError,
} from "../app/lib/extractDocumentText";

export interface AiSource {
  id: number;
  name: string;
  charCount: number;
}

interface ApiClientLike {
  post: (url: string, data?: unknown) => Promise<{ data: unknown }>;
  get: (url: string) => Promise<{ data: unknown }>;
  delete?: (url: string) => Promise<{ data: unknown }>;
}

const MAX_TEXT_BYTES = 400_000;
const MAX_CHARS = 200_000;
const TEXT_FILE_PATTERN = /\.(txt|md|markdown|csv|json|log|html?|xml|ya?ml)$/i;

export const isPdfFile = (file: File) =>
  file.type === "application/pdf" || /\.pdf$/i.test(file.name);

export const isDocumentFile = (file: File) => isPdfFile(file) || isOfficeFile(file);

export const isTextFile = (file: File) =>
  file.type.startsWith("text/") || TEXT_FILE_PATTERN.test(file.name);

function messageFrom(error: unknown, fallback: string) {
  return (
    (error as { response?: { data?: { message?: string } } }).response?.data
      ?.message || fallback
  );
}

/** Per-canvas reference sources (RAG corpus) plus AI-suggested questions about them. */
export function useAiSources(
  roomId: number | null,
  httpBackend: string,
  apiClient: ApiClientLike,
) {
  const [sources, setSources] = useState<AiSource[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [questions, setQuestions] = useState<string[]>([]);
  const [loadingQuestions, setLoadingQuestions] = useState(false);
  const base = roomId ? `${httpBackend}/room/${roomId}/sources` : null;
  const baseRef = useRef(base);
  baseRef.current = base;

  const loadQuestions = useCallback(async () => {
    if (!base) return;
    setLoadingQuestions(true);
    try {
      const res = await apiClient.get(`${base}/suggestions`);
      if (baseRef.current !== base) return;
      setQuestions(
        (res.data as { data?: { questions?: string[] } })?.data?.questions ?? [],
      );
    } catch {
      if (baseRef.current === base) setQuestions([]);
    } finally {
      if (baseRef.current === base) setLoadingQuestions(false);
    }
  }, [apiClient, base]);

  useEffect(() => {
    setSources([]);
    setQuestions([]);
    setError(null);
    if (!base) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiClient.get(base);
        const list =
          (res.data as { data?: { sources?: AiSource[] } })?.data?.sources ?? [];
        if (cancelled) return;
        setSources(list);
        if (list.length > 0) void loadQuestions();
      } catch {
        // Sources are optional; chat works without them.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiClient, base, loadQuestions]);

  const addText = useCallback(
    async (name: string, text: string) => {
      if (!base) return false;
      setError(null);
      setPending((p) => [...p, name]);
      try {
        const res = await apiClient.post(base, { name, text: text.slice(0, MAX_CHARS) });
        const source = (res.data as { data?: { source?: AiSource } })?.data?.source;
        if (source) setSources((prev) => [...prev, source]);
        void loadQuestions();
        return true;
      } catch (e) {
        setError(messageFrom(e, `Could not add ${name}.`));
        return false;
      } finally {
        setPending((p) => {
          const i = p.indexOf(name);
          return i < 0 ? p : [...p.slice(0, i), ...p.slice(i + 1)];
        });
      }
    },
    [apiClient, base, loadQuestions],
  );

  /** Adds a PDF, Word/Excel/PowerPoint or text file as a source. Returns false (with `error` set) if it can't. */
  const addFile = useCallback(
    async (file: File) => {
      setError(null);
      const doc = isDocumentFile(file);
      if (!doc && !isTextFile(file)) {
        setError(
          /\.(doc|xls|ppt)$/i.test(file.name)
            ? `${file.name}: old .doc/.xls/.ppt files aren't supported — save as .docx/.xlsx/.pptx.`
            : `${file.name}: supported types are PDF, Word, Excel, PowerPoint, txt, md, csv, json, html.`,
        );
        return false;
      }
      const limit = isPdfFile(file)
        ? MAX_PDF_FILE_BYTES
        : isOfficeFile(file)
          ? MAX_OFFICE_FILE_BYTES
          : MAX_TEXT_BYTES;
      if (file.size > limit) {
        setError(`${file.name} is too large (max ${Math.round(limit / 1_000_000)} MB).`);
        return false;
      }
      // Text is extracted here in the browser; the server only ever gets plain text.
      let text: string;
      setPending((p) => [...p, file.name]);
      try {
        text = await extractDocumentText(file);
      } catch (e) {
        setError(
          e instanceof UnsafeArchiveError
            ? `${file.name}: ${e.message}`
            : `Could not read ${file.name}.`,
        );
        return false;
      } finally {
        setPending((p) => {
          const i = p.indexOf(file.name);
          return i < 0 ? p : [...p.slice(0, i), ...p.slice(i + 1)];
        });
      }
      if (text.trim().length < 20) {
        setError(`${file.name}: no readable text found (scanned images aren't supported).`);
        return false;
      }
      return await addText(file.name, text);
    },
    [addText],
  );

  const remove = useCallback(
    async (id: number) => {
      if (!base || !apiClient.delete) return;
      const previous = sources;
      const next = sources.filter((s) => s.id !== id);
      setSources(next);
      try {
        await apiClient.delete(`${base}/${id}`);
        if (next.length === 0) setQuestions([]);
        else void loadQuestions();
      } catch {
        setSources(previous);
        setError("Could not remove that source.");
      }
    },
    [apiClient, base, loadQuestions, sources],
  );

  return {
    sources,
    pending,
    error,
    clearError: () => setError(null),
    questions,
    loadingQuestions,
    addFile,
    addText,
    remove,
  };
}
