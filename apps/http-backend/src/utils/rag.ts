import axios from "axios";
import { prismaClient } from "@repo/db/client";

// File intent: Chunk, embed and retrieve per-canvas reference material (RAG) using Gemini embeddings.

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const EMBED_MODEL = "gemini-embedding-001";
const EMBED_DIMENSIONS = 768;
const EMBED_BATCH_SIZE = 50;
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 150;
// Alias (not GEMINI_MODEL_CANDIDATES): pinned model names in that secret may 404.
const TEXT_MODEL = "gemini-flash-latest";

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
  const chunks = chunkText(params.text);
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

  const [queryVector] = await embed([query.slice(0, 2000)], "RETRIEVAL_QUERY");
  if (!queryVector) return [];

  return rows
    .map((row) => ({
      content: row.content,
      sourceName: row.source.name,
      score: cosine(queryVector, row.embedding),
    }))
    .sort((a, b) => b.score - a.score)
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

async function generateJson<T>(prompt: string): Promise<T> {
  const res = await axios.post<{
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  }>(
    `${GEMINI_BASE}/models/${TEXT_MODEL}:generateContent`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    },
    { headers: { "x-goog-api-key": apiKey() }, timeout: 45_000 },
  );
  const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
  return JSON.parse(text) as T;
}

/** Diagram-oriented questions a user could ask about their sources. */
export async function suggestQuestions(roomId: number): Promise<string[]> {
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
  return Array.isArray(questions)
    ? questions
        .filter((q): q is string => typeof q === "string")
        .map((q) => q.trim())
        .filter(Boolean)
        .slice(0, 6)
    : [];
}
