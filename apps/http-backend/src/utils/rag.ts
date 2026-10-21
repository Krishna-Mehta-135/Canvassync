import axios from "axios";
import { prismaClient } from "@repo/db/client";

// File intent: Chunk, embed and retrieve per-canvas reference material (RAG) using Gemini embeddings.

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const EMBED_MODEL = "gemini-embedding-001";
const EMBED_DIMENSIONS = 768;
const EMBED_BATCH_SIZE = 50;
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 150;
// Aliases (not GEMINI_MODEL_CANDIDATES): pinned model names in that secret may 404.
// The lite alias is the fallback when the main model is out of quota or overloaded.
const TEXT_MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest"];

function apiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key === "your_gemini_api_key_here") {
    throw new Error("GEMINI_API_KEY is not configured");
  }
  return key;
}

/** Split on paragraph/sentence boundaries into ~CHUNK_SIZE pieces with a small overlap. */
export function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  if (!clean) return [];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + CHUNK_SIZE, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const breakAt = Math.max(
        window.lastIndexOf("\n\n"),
        window.lastIndexOf(". "),
        window.lastIndexOf("\n"),
      );
      if (breakAt > CHUNK_SIZE * 0.5) end = start + breakAt + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}

async function embed(
  texts: string[],
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY",
): Promise<number[][]> {
  const key = apiKey();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const res = await axios.post<{ embeddings: Array<{ values: number[] }> }>(
      `${GEMINI_BASE}/models/${EMBED_MODEL}:batchEmbedContents`,
      {
        requests: batch.map((text) => ({
          model: `models/${EMBED_MODEL}`,
          content: { parts: [{ text }] },
          taskType,
          outputDimensionality: EMBED_DIMENSIONS,
        })),
      },
      { headers: { "x-goog-api-key": key }, timeout: 30_000 },
    );
    for (const e of res.data.embeddings) out.push(e.values);
  }
  return out;
}

function cosine(a: number[], b: number[]) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export async function indexSource(params: {
  roomId: number;
  userId: string;
  name: string;
  text: string;
}) {
  // NUL bytes break Postgres text columns.
  const chunks = chunkText(params.text.split("\0").join(""));
  if (chunks.length === 0) throw new Error("Source has no readable text");
  const vectors = await embed(chunks, "RETRIEVAL_DOCUMENT");

  return prismaClient.roomSource.create({
    data: {
      roomId: params.roomId,
      userId: params.userId,
      name: params.name,
      charCount: params.text.length,
      chunks: {
        create: chunks.map((content, position) => ({
          roomId: params.roomId,
          position,
          content,
          embedding: vectors[position] ?? [],
        })),
      },
    },
    select: { id: true, name: true, charCount: true, createdAt: true },
  });
}

export async function hasSources(roomId: number) {
  return (await prismaClient.roomSource.count({ where: { roomId } })) > 0;
}

const QUERY_CACHE_MAX = 200;
const queryVectorCache = new Map<string, number[]>();

async function embedQuery(query: string): Promise<number[] | undefined> {
  const key = query.trim().toLowerCase();
  const cached = queryVectorCache.get(key);
  if (cached) return cached;
  const [vector] = await embed([query], "RETRIEVAL_QUERY");
  if (vector) {
    if (queryVectorCache.size >= QUERY_CACHE_MAX) {
      queryVectorCache.delete(queryVectorCache.keys().next().value as string);
    }
    queryVectorCache.set(key, vector);
  }
  return vector;
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "how", "what",
  "does", "are", "was", "were", "will", "can", "you", "your", "make", "draw",
  "show", "create", "diagram", "about", "have", "has", "its", "our", "all",
]);

function keywords(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
    ),
  );
}

/** Share of query keywords present in the chunk: rescues exact names/IDs embeddings blur. */
function keywordScore(queryWords: string[], content: string) {
  if (queryWords.length === 0) return 0;
  const haystack = content.toLowerCase();
  let hits = 0;
  for (const w of queryWords) if (haystack.includes(w)) hits += 1;
  return hits / queryWords.length;
}

const KEYWORD_WEIGHT = 0.2;
const MIN_SCORE = 0.25;

export interface RetrievedChunk {
  content: string;
  sourceName: string;
  score: number;
}

export async function retrieveChunks(
  roomId: number,
  query: string,
  k = 6,
): Promise<RetrievedChunk[]> {
  const rows = await prismaClient.sourceChunk.findMany({
    where: { roomId },
    select: {
      content: true,
      embedding: true,
      source: { select: { name: true } },
    },
  });
  if (rows.length === 0) return [];

  const trimmed = query.slice(0, 2000);
  const queryVector = await embedQuery(trimmed);
  if (!queryVector) return [];
  const queryWords = keywords(trimmed);

  const ranked = rows
    .map((row) => ({
      content: row.content,
      sourceName: row.source.name,
      score:
        cosine(queryVector, row.embedding) +
        KEYWORD_WEIGHT * keywordScore(queryWords, row.content),
    }))
    .sort((a, b) => b.score - a.score);

  // Drop clearly unrelated passages, but always keep the single best one.
  return ranked
    .filter((c, i) => i === 0 || c.score >= MIN_SCORE)
    .slice(0, k);
}

/** Prompt prefix that grounds a diagram request in the retrieved passages. */
export function buildReferenceBlock(chunks: RetrievedChunk[]) {
  if (chunks.length === 0) return "";
  const body = chunks
    .map((c, i) => `[${i + 1}] (${c.sourceName}) ${c.content}`)
    .join("\n\n");
  return `Reference material from the user's uploaded sources. Ground labels, names and structure in it where relevant; do not invent facts it contradicts:\n${body}\n\n---\nRequest: `;
}

/** Retry transient Gemini failures (429/5xx/timeouts/bad JSON) a couple of times. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = (error as { response?: { status?: number } }).response?.status;
      const transient =
        status === undefined || status === 429 || status >= 500 || error instanceof SyntaxError;
      if (!transient || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  console.warn("[RAG] Gemini call failed:", (lastError as Error)?.message);
  throw lastError;
}

function modelConfig(model: string, extra: Record<string, unknown>) {
  // The lite models reject the thinking setting.
  return model.includes("lite")
    ? extra
    : { ...extra, thinkingConfig: { thinkingBudget: 0 } };
}

/** Try each model in turn; move on when one is rate limited, overloaded or missing. */
async function withModelFallback<T>(call: (model: string) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (const model of TEXT_MODELS) {
    try {
      return await withRetry(() => call(model), 2);
    } catch (error) {
      lastError = error;
      const status = (error as { response?: { status?: number } }).response?.status;
      const fallbackWorthy = status === undefined || status === 429 || status === 404 || status >= 500;
      if (!fallbackWorthy) break;
    }
  }
  throw lastError;
}

async function generateText(prompt: string): Promise<string> {
  return withModelFallback(async (model) => {
    const res = await axios.post<{
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    }>(
      `${GEMINI_BASE}/models/${model}:generateContent`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: modelConfig(model, {}),
      },
      { headers: { "x-goog-api-key": apiKey() }, timeout: 45_000 },
    );
    return res.data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  });
}

async function generateJson<T>(prompt: string): Promise<T> {
  return withModelFallback(async (model) => {
    const res = await axios.post<{
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    }>(
      `${GEMINI_BASE}/models/${model}:generateContent`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: modelConfig(model, { responseMimeType: "application/json" }),
      },
      { headers: { "x-goog-api-key": apiKey() }, timeout: 45_000 },
    );
    const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
    return JSON.parse(text) as T;
  });
}

const suggestionCache = new Map<string, string[]>();

/** Diagram-oriented questions a user could ask about their sources. */
export async function suggestQuestions(roomId: number): Promise<string[]> {
  // Cached per room until its set of sources changes, so reopening the chat is instant.
  const [count, latest] = await Promise.all([
    prismaClient.roomSource.count({ where: { roomId } }),
    prismaClient.roomSource.findFirst({
      where: { roomId },
      orderBy: { id: "desc" },
      select: { id: true },
    }),
  ]);
  const cacheKey = `${roomId}:${count}:${latest?.id ?? 0}`;
  const cached = suggestionCache.get(cacheKey);
  if (cached) return cached;

  const chunks = await prismaClient.sourceChunk.findMany({
    where: { roomId },
    orderBy: [{ sourceId: "asc" }, { position: "asc" }],
    select: { content: true, source: { select: { name: true } } },
  });
  if (chunks.length === 0) return [];

  // Spread samples across the corpus so every source is represented.
  const step = Math.max(1, Math.ceil(chunks.length / 8));
  const sample = chunks
    .filter((_, i) => i % step === 0)
    .slice(0, 8)
    .map((c) => `(${c.source.name}) ${c.content.slice(0, 700)}`)
    .join("\n\n");

  const questions = await generateJson<unknown>(
    `You help someone turn reference material into whiteboard diagrams. From the excerpts below, write 5 short requests they could give an AI diagram tool, each producing a specific diagram (flow, architecture, timeline, hierarchy, comparison) grounded in the material. Each under 90 characters, imperative, no numbering. Return a JSON array of strings only.\n\nExcerpts:\n${sample}`,
  );
  const result = Array.isArray(questions)
    ? questions
        .filter((q): q is string => typeof q === "string")
        .map((q) => q.trim())
        .filter(Boolean)
        .slice(0, 6)
    : [];
  if (result.length > 0) {
    if (suggestionCache.size >= 100) {
      suggestionCache.delete(suggestionCache.keys().next().value as string);
    }
    suggestionCache.set(cacheKey, result);
  }
  return result;
}

export interface AskTurn {
  role: "user" | "ai";
  text: string;
}

export interface AskResult {
  answer: string;
  citations: Array<{ n: number; sourceName: string; snippet: string }>;
}

function formatHistory(history: AskTurn[] = []) {
  return history
    .slice(-6)
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text.slice(0, 500)}`)
    .join("\n");
}

/** Text answer to a question, grounded in the canvas sources with numbered citations. */
export async function answerQuestion(params: {
  roomId: number;
  question: string;
  history?: AskTurn[];
  board?: string;
}): Promise<AskResult> {
  const retrievalQuery = [
    ...(params.history ?? []).slice(-2).filter((t) => t.role === "user").map((t) => t.text),
    params.question,
  ].join(" ");
  const chunks = await retrieveChunks(params.roomId, retrievalQuery, 6);

  const sourceBlock = chunks.length
    ? chunks.map((c, i) => `[${i + 1}] (${c.sourceName}) ${c.content}`).join("\n\n")
    : "(no uploaded sources)";
  const prompt = `You are the assistant inside a collaborative whiteboard app. Answer the user's question clearly and concisely (under 180 words, short paragraphs or bullets, no headings).
Use the numbered source passages when relevant and cite them inline like [1] or [2]. If the sources don't cover it, say so briefly, then answer from general knowledge. Never invent citations. Don't mention modes or switching; the user can click "Draw this" under your answer to turn it into a diagram.

Sources:
${sourceBlock}

${params.board ? `Text currently on the board:\n${params.board}\n\n` : ""}${params.history?.length ? `Conversation so far:\n${formatHistory(params.history)}\n\n` : ""}User: ${params.question}`;

  const answer = (await generateText(prompt)).trim();
  const cited = new Set(
    Array.from(answer.matchAll(/\[(\d+)\]/g)).map((m) => Number(m[1])),
  );
  const citations = chunks
    .map((c, i) => ({
      n: i + 1,
      sourceName: c.sourceName,
      snippet: c.content.replace(/\s+/g, " ").slice(0, 220),
    }))
    .filter((c) => cited.has(c.n));
  return { answer, citations };
}

/** Compact "recent conversation" prefix so follow-up draw requests keep context. */
export function buildHistoryBlock(history: AskTurn[] | undefined) {
  if (!history?.length) return "";
  return `Recent conversation (for context only):\n${formatHistory(history)}\n\n`;
}
