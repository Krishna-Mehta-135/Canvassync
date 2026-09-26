/**
 * ai-worker/src/index.ts
 *
 * Standalone Node.js process that:
 *  1. Connects to RabbitMQ and consumes AI generate jobs
 *  2. Calls the Gemini API (gemini-flash-latest alias) with a structured prompt
 *  3. Parses + validates the returned JSON shapes
 *  4. POSTs the result back to the HTTP backend via /internal/ai/result
 */

import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { subscribeAiGenerateJobs, type AiGenerateJob } from "@repo/queue-sync";
import { CanvasShapeSchema } from "@repo/common/types";
import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";
import { z } from "zod";
import { randomUUID } from "node:crypto";

// File intent: Generate robust, complete AI diagrams and recover from malformed/truncated model output.

// Load env from root .env files regardless of current working directory.
const envCandidates = [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../.env"),
  resolve(process.cwd(), "../../.env"),
  resolve(process.cwd(), ".env.local"),
  resolve(process.cwd(), "../.env.local"),
  resolve(process.cwd(), "../../.env.local"),
];

for (const envPath of envCandidates) {
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath, quiet: true });
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const INTERNAL_SECRET =
  process.env.INTERNAL_SECRET ?? "canvas-internal-dev-secret-2024";
const HTTP_BACKEND_INTERNAL_URL =
  process.env.HTTP_BACKEND_INTERNAL_URL ?? "http://127.0.0.1:3001";
const MAX_GENERATION_ATTEMPTS = 3;
const MAX_AUTOMATIC_RATE_LIMIT_WAIT_MS = 90_000;
const MODEL_CANDIDATES = (
  process.env.GEMINI_MODEL_CANDIDATES ??
  "gemini-flash-latest,gemini-flash-lite-latest"
)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

if (!GEMINI_API_KEY || GEMINI_API_KEY === "your_gemini_api_key_here") {
  console.error(
    "[AI Worker] GEMINI_API_KEY is not set. Get one at https://aistudio.google.com",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Gemini system instruction — teaches the model the exact JSON contract
// ---------------------------------------------------------------------------
const SYSTEM_INSTRUCTION = `You are a canvas diagram generator for a collaborative whiteboard app.
Return ONLY a valid JSON array. No markdown, no explanation, no prefix/suffix text.

Allowed shape schemas:
- rect: {"type":"rect","id":"<uuid>","x":n,"y":n,"width":n,"height":n,"stroke":"#hex","fill":"#hex","strokeWidth":2}
- circle: {"type":"circle","id":"<uuid>","centerX":n,"centerY":n,"radiusX":n,"radiusY":n,"stroke":"#hex","fill":"#hex"}
- rhombus: {"type":"rhombus","id":"<uuid>","x":n,"y":n,"width":n,"height":n,"stroke":"#hex","fill":"#hex"}
- arrow: {"type":"arrow","id":"<uuid>","x1":n,"y1":n,"x2":n,"y2":n,"stroke":"#hex","strokeWidth":2}
- line: {"type":"line","id":"<uuid>","x1":n,"y1":n,"x2":n,"y2":n,"stroke":"#hex"}
- text: {"type":"text","id":"<uuid>","x":n,"y":n,"text":"string","fontSize":16,"width":n,"height":24,"stroke":"#hex"}

Layout + quality rules:
- Coordinates: x 100-900, y 80-680.
- First shape MUST be heading text (title) near y 100-120.
- Semantic Tool Usage (REQUIRED for Architecture/System diagrams):
  * Use 'rect' for Services, Servers, Microservices, or large conceptual blocks.
  * Use 'circle' for Users, Actors, Databases, or external entry points.
  * Use 'rhombus' for Decision points, Gateways, Load Balancers, or Logic checks.
  * Combine these tools! Do not use only one node type for a complex system.
- Generate 1 heading + 10-40 content shapes.
- Keep text labels concise.
- JSON: MINIFIED ONLY. No newlines, no extra spaces, no comments. This is critical for fitting large diagrams.
- Place labels inside/adjacent to nodes; text width must be > 0 (roughly chars*8), height >= 24.
- Arrows/lines must connect shape edges, not through shape centers.
- When existing shapes are provided in prompt, place all new shapes in empty space (avoid overlap).
- Favor rich structure over minimal outputs: include multiple sections/layers, branching where relevant, and enough supporting nodes to make the diagram actionable.
- For architecture/workflow/system prompts, aim for at least 3 tiers (clients, services, data/infra) or equivalent logical groupings.

Color palette:
- Blue: fill "#3B82F6", stroke "#1E40AF"
- Green: fill "#10B981", stroke "#047857"
- Amber: fill "#F59E0B", stroke "#B45309"
- Violet: fill "#8B5CF6", stroke "#5B21B6"
- Red: fill "#EF4444", stroke "#991B1B"
- Sky: fill "#06B6D4", stroke "#0891B2"
- Connectors/text: stroke "#94A3B8" or darker matching text color

JSON rules:
- Valid JSON only, double-quoted keys/strings, no trailing commas, no comments.
- Start with '[' and end with ']'.`;

// Edit mode: rewrite an existing selection instead of drawing something new.
const EDIT_SYSTEM_INSTRUCTION = `You are an editor for diagrams on a collaborative whiteboard.
You receive CURRENT shapes as a JSON array and an INSTRUCTION. Return ONLY a valid, MINIFIED JSON array containing the complete new version of those shapes. No markdown, no explanation.

Rules:
- Keep the same "id" for every shape you keep or modify. Give brand-new unique ids to shapes you add. Omit a shape to delete it.
- Preserve every property you were not asked to change (position, size, colors, text).
- Keep the layout near the original coordinates unless the instruction asks to move, re-layout, align or tidy things.
- Shape schemas are identical to the input: rect {x,y,width,height}, circle {centerX,centerY,radiusX,radiusY}, rhombus {x,y,width,height}, arrow/line {x1,y1,x2,y2}, text {x,y,text,fontSize,width,height}. Colors are "#hex" in "stroke" and "fill".
- Text shapes need width > 0 (roughly chars*8) and height >= 24. New arrows must connect shape edges.
- When asked to translate/rewrite/shorten labels, only change the "text" values.
- Valid JSON only: double-quoted keys, no trailing commas, start with '[' and end with ']'.`;

// ---------------------------------------------------------------------------
// Build the Gemini model using getGenerativeModel
// ---------------------------------------------------------------------------
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY!);

const modelCache = new Map<
  string,
  ReturnType<typeof genAI.getGenerativeModel>
>();

function getModel(modelName: string, edit = false) {
  const cacheKey = `${edit ? "edit" : "gen"}:${modelName}`;
  const cached = modelCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: edit ? EDIT_SYSTEM_INSTRUCTION : SYSTEM_INSTRUCTION,
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 12288,
      responseMimeType: "application/json",
    },
  });

  modelCache.set(cacheKey, model);
  return model;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(message: string): number | null {
  const retrySecondsMatch = message.match(/retry in\s+([0-9]+(?:\.[0-9]+)?)s/i);
  if (!retrySecondsMatch) {
    return null;
  }

  const seconds = Number(retrySecondsMatch[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  return Math.ceil(seconds * 1000);
}

function summarizeQuotaError(message: string) {
  const retryAfterMs = parseRetryAfterMs(message);
  const timeHint = retryAfterMs
    ? ` (retry after ${Math.ceil(retryAfterMs / 1000)}s)`
    : "";
  return {
    retryAfterMs,
    userMessage: `Gemini API rate limit exceeded${timeHint}. Using fallback if available.`,
  };
}

function isRateLimitError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("429") ||
    m.includes("quota") ||
    m.includes("rate limit") ||
    m.includes("resource_exhausted")
  );
}

// ---------------------------------------------------------------------------
// Helpers for prompt parsing and layout
// ---------------------------------------------------------------------------

function extractCurrentCanvasShapes(prompt: string): unknown[] {
  try {
    const marker = "Current canvas occupancy regions (";
    const startIdx = prompt.lastIndexOf(marker);
    if (startIdx === -1) return [];

    const jsonStart = prompt.indexOf("[", startIdx);
    if (jsonStart === -1) return [];

    const jsonEnd = prompt.lastIndexOf("]");
    if (jsonEnd === -1 || jsonEnd < jsonStart) return [];

    return JSON.parse(prompt.substring(jsonStart, jsonEnd + 1));
  } catch {
    return [];
  }
}

function getShapesBounds(shapes: unknown[]) {
  if (shapes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  shapes.forEach((s) => {
    const shape = s as Record<string, unknown>;
    // Handle both raw occupancy regions and full shapes
    const sx1 = Number(shape.minX ?? shape.x ?? shape.centerX ?? 0);
    const sy1 = Number(shape.minY ?? shape.y ?? shape.centerY ?? 0);
    const sx2 = Number(
      shape.maxX ??
        (shape.width ? sx1 + (shape.width as number) : shape.radiusX ? sx1 + (shape.radiusX as number) : sx1),
    );
    const sy2 = Number(
      shape.maxY ??
        (shape.height ? sy1 + (shape.height as number) : shape.radiusY ? sy1 + (shape.radiusY as number) : sy1),
    );

    minX = Math.min(minX, sx1);
    minY = Math.min(minY, sy1);
    maxX = Math.max(maxX, sx2);
    maxY = Math.max(maxY, sy2);
  });

  return { minX, minY, maxX, maxY };
}

function translateShapes(shapes: unknown[], dx: number, dy: number): unknown[] {
  return shapes.map((s) => {
    const shape = s as Record<string, unknown>;
    const type = shape.type;
    if (type === "rect" || type === "rhombus" || type === "text") {
      return { ...shape, x: (shape.x as number) + dx, y: (shape.y as number) + dy };
    }
    if (type === "circle") {
      return {
        ...shape,
        centerX: (shape.centerX as number) + dx,
        centerY: (shape.centerY as number) + dy,
      };
    }
    if (type === "line" || type === "arrow") {
      return {
        ...shape,
        x1: (shape.x1 as number) + dx,
        y1: (shape.y1 as number) + dy,
        x2: (shape.x2 as number) + dx,
        y2: (shape.y2 as number) + dy,
      };
    }
    return shape;
  });
}

function collidesWithAny(candidate: any, others: any[], padding: number) {
  return others.some((other) => {
    return !(
      candidate.minX > other.maxX + padding ||
      candidate.maxX < other.minX - padding ||
      candidate.minY > other.maxY + padding ||
      candidate.maxY < other.minY - padding
    );
  });
}

function placeGeneratedShapesInEmptyRegion(
  generatedRecords: unknown[],
  existingShapes: unknown[],
): unknown[] {
  if (existingShapes.length === 0) return generatedRecords;

  const generatedBounds = getShapesBounds(generatedRecords);
  const existingBounds = getShapesBounds(existingShapes);
  if (!generatedBounds || !existingBounds) return generatedRecords;

  // Try standard offsets to find a large empty area.
  const GAP_X = 160;
  const GAP_Y = 160;
  const COLLISION_PADDING = 40;
  const existingShapeBounds = existingShapes.map((s) => {
    const b = getShapesBounds([s]);
    return b!;
  });

  // Strategy: Try Right, then Down, then Bottom-Right.
  const candidates = [
    { dx: existingBounds.maxX + GAP_X - generatedBounds.minX, dy: 0 },
    { dx: 0, dy: existingBounds.maxY + GAP_Y - generatedBounds.minY },
    {
      dx: existingBounds.maxX + GAP_X - generatedBounds.minX,
      dy: existingBounds.maxY + GAP_Y - generatedBounds.minY,
    },
  ];

  for (const { dx, dy } of candidates) {
    const candidate = {
      minX: generatedBounds.minX + dx,
      minY: generatedBounds.minY + dy,
      maxX: generatedBounds.maxX + dx,
      maxY: generatedBounds.maxY + dy,
    };

    if (!collidesWithAny(candidate, existingShapeBounds, COLLISION_PADDING)) {
      return translateShapes(generatedRecords, dx, dy);
    }
  }

  // Last resort: put it below the entire current canvas block.
  const fallbackDx = Math.max(100, existingBounds.minX) - generatedBounds.minX;
  const fallbackDy = existingBounds.maxY + GAP_Y * 2 - generatedBounds.minY;
  return translateShapes(generatedRecords, fallbackDx, fallbackDy);
}

function extractJsonArrayString(rawText: string): string {
  // Strip accidental markdown fences (```json ... ```), then search for the JSON array.
  const stripped = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  const startIdx = stripped.indexOf("[");
  const endIdx = stripped.lastIndexOf("]");

  if (startIdx === -1) {
    const snippet = rawText.slice(0, 300);
    console.error(`[AI Worker] Response missing '['. Raw snippet: ${snippet}`);
    throw new Error(
      `Gemini response does not contain a JSON array start token '[': ${snippet}`,
    );
  }

  if (endIdx === -1 || endIdx < startIdx) {
    const snippet = rawText.slice(-300);
    console.error(`[AI Worker] Response appears truncated (missing ']'). End snippet: ${snippet}`);
    throw new Error(
      `Gemini response appears truncated (missing closing ']'): ${snippet}`,
    );
  }

  return stripped.substring(startIdx, endIdx + 1);
}

/**
 * If Gemini hits MAX_TOKENS or otherwise truncates the response mid-array,
 * we can often salvage the earlier shapes by finding the last complete object
 * and closing the array ourselves.
 */
function tryRepairTruncatedJson(rawText: string): string {
  const text = rawText.trim();
  const startIdx = text.indexOf("[");
  if (startIdx === -1) return rawText;

  const arrayContent = text.substring(startIdx);

  // If it already ends with ']', it's not obviously truncated in a way we fix here.
  if (arrayContent.endsWith("]")) return arrayContent;

  // Find the last closing brace of a complete shape object.
  const lastBrace = arrayContent.lastIndexOf("}");
  if (lastBrace === -1) return arrayContent;

  const repaired = arrayContent.substring(0, lastBrace + 1) + "]";
  console.warn(
    `[AI Worker] Repaired truncated JSON (salvaged up to last complete object).`,
  );
  return repaired;
}

function validateAndNormalizeShapes(parsed: unknown): unknown[] {
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Gemini response was not a JSON array. Got ${typeof parsed}: ${JSON.stringify(parsed).slice(0, 240)}`,
    );
  }

  // Assign proper UUIDs to any shapes that have placeholder or duplicate IDs.
  const usedIds = new Set<string>();
  const shapesWithIds = (parsed as unknown[]).map((shape) => {
    const s = shape as Record<string, unknown>;
    const existingId = typeof s["id"] === "string" ? s["id"] : "";
    const needsId =
      !existingId || existingId.length < 8 || usedIds.has(existingId);
    const id = needsId ? randomUUID() : existingId;
    usedIds.add(id);
    return { ...s, id };
  });

  const ShapeArraySchema = z.array(CanvasShapeSchema);
  const validated = ShapeArraySchema.safeParse(shapesWithIds);
  if (!validated.success) {
    throw new Error(`Shape validation failed: ${validated.error.message}`);
  }

  return validated.data;
}

function getQualityIssue(shapes: unknown[], prompt: string): string | null {
  const shapeRecords = shapes as Array<Record<string, unknown>>;
  const textShapes = shapeRecords.filter((s) => s.type === "text");
  const nodeShapes = shapeRecords.filter(
    (s) => s.type === "rect" || s.type === "circle" || s.type === "rhombus",
  );
  const edgeShapes = shapeRecords.filter(
    (s) => s.type === "arrow" || s.type === "line",
  );
  const nodeTypeCount = new Set(nodeShapes.map((s) => s.type)).size;
  const architectureLikePrompt =
    /(architecture|system|platform|microservice|infra|pipeline|workflow|process|sequence|journey)/i.test(
      prompt,
    );
  const branchingPrompt =
    /(decision|branch|if\/else|approval|gateway|conditional)/i.test(prompt);

  const minimumShapes = architectureLikePrompt ? 10 : 7;
  if (shapeRecords.length < minimumShapes) {
    return "too_few_shapes";
  }
  if (shapeRecords.length > 60) {
    return "too_many_shapes";
  }
  if (textShapes.length === 0 || textShapes[0]?.type !== "text") {
    return "missing_heading";
  }
  if (nodeShapes.length < (architectureLikePrompt ? 4 : 2)) {
    return "too_few_nodes";
  }
  if (architectureLikePrompt && nodeTypeCount < 2) {
    return "low_tool_diversity";
  }

  const needsConnectors =
    /(flow|pipeline|process|workflow|architecture|erd|sequence|journey|system)/i.test(
      prompt,
    );
  if (needsConnectors && edgeShapes.length < (architectureLikePrompt ? 3 : 1)) {
    return "missing_connectors";
  }

  if (branchingPrompt) {
    const rhombusCount = shapeRecords.filter(
      (s) => s.type === "rhombus",
    ).length;
    if (rhombusCount < 1) {
      return "missing_decision_nodes";
    }
  }

  return null;
}

function buildAttemptPrompt(
  basePrompt: string,
  attempt: number,
  previousIssue?: string,
): string {
  if (attempt === 0) {
    return basePrompt;
  }

  const issueHint = previousIssue
    ? `Previous attempt issue: ${previousIssue}.`
    : "";
  return `${basePrompt}\n\nRetry constraints:\n${issueHint}\n- Return MINIFIED valid JSON array only (no prose, no whitespace).\n- If the previous response was truncated, focus on the most important 25-35 shapes.\n- Generate 10-40 content shapes total (plus heading).\n- Ensure first shape is heading text and include connectors for flow/pipeline/architecture prompts.\n- Ensure JSON is complete with closing brackets.`;
}

// ---------------------------------------------------------------------------
// Call Gemini and parse the response into validated, complete shape objects.
// ---------------------------------------------------------------------------
async function generateShapesFromPrompt(prompt: string): Promise<unknown[]> {
  let lastError = "Unknown generation failure";
  let previousIssue: string | undefined;
  const existingShapes = extractCurrentCanvasShapes(prompt);
  const models =
    MODEL_CANDIDATES.length > 0 ? MODEL_CANDIDATES : ["gemini-flash-latest"];

  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const attemptPrompt = buildAttemptPrompt(prompt, attempt, previousIssue);
    for (const modelName of models) {
      try {
        const responseResult = await getModel(modelName).generateContent(attemptPrompt);
        const response = responseResult.response;
        const rawText = response.text();

        // Log truncation/finish reason if available to help debugging
        const candidate = response.candidates?.[0];
        const isMaxTokens = candidate?.finishReason === "MAX_TOKENS";
        if (candidate?.finishReason && candidate.finishReason !== "STOP") {
          console.warn(
            `[AI Worker] Gemini finishReason: ${candidate.finishReason} for model ${modelName}`,
          );
        }

        let jsonStr: string;
        try {
          jsonStr = extractJsonArrayString(rawText);
        } catch (extractErr) {
          // If truncated by tokens, try to salvage partial response
          if (isMaxTokens) {
            jsonStr = tryRepairTruncatedJson(rawText);
          } else {
            throw extractErr;
          }
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(jsonStr);
        } catch (err) {
          console.error(`[AI Worker] Failed to parse JSON from Gemini. Raw text snippet: ${rawText.slice(0, 500)}...`);
          throw new Error(
            `Gemini returned invalid JSON on attempt ${attempt + 1}: ${(err as Error).message}. Snippet: ${jsonStr.slice(0, 300)}`,
          );
        }

        const normalizedShapes = validateAndNormalizeShapes(parsed);
        const shapes = placeGeneratedShapesInEmptyRegion(
          normalizedShapes,
          existingShapes,
        );
        const qualityIssue = getQualityIssue(shapes, prompt);
        if (qualityIssue) {
          if (attempt < MAX_GENERATION_ATTEMPTS - 1) {
            previousIssue = qualityIssue;
            lastError = `Diagram quality check failed (${qualityIssue}) on attempt ${attempt + 1}`;
            continue;
          } else {
            console.warn(
              `[AI Worker] Quality check failed (${qualityIssue}) on last attempt; returning best-effort result.`,
            );
          }
        }

        if (attempt > 0 && !qualityIssue) {
          console.warn(
            `[AI Worker] Recovered generation after retry ${attempt + 1}`,
          );
        }
        return shapes;
      } catch (err) {
        const rawMessage = err instanceof Error ? err.message : String(err);

        if (isRateLimitError(rawMessage)) {
          const { retryAfterMs, userMessage } = summarizeQuotaError(rawMessage);
          lastError = userMessage;

          // If this model is rate-limited, immediately try next candidate model.
          if (modelName !== models[models.length - 1]) {
            console.warn(
              `[AI Worker] Rate limit on ${modelName}; trying fallback model`,
            );
            continue;
          }

          // Only auto-wait for short retry windows to avoid hanging long-running jobs.
          if (
            retryAfterMs &&
            retryAfterMs <= MAX_AUTOMATIC_RATE_LIMIT_WAIT_MS &&
            attempt < MAX_GENERATION_ATTEMPTS - 1
          ) {
            const waitMs = retryAfterMs + 500;
            console.warn(
              `[AI Worker] Rate limited; waiting ${waitMs}ms before retry`,
            );
            await sleep(waitMs);
            break;
          }

          throw new Error(userMessage);
        }

        lastError = rawMessage;
      }
    }
  }

  throw new Error(
    `AI generation failed after ${MAX_GENERATION_ATTEMPTS} attempts: ${lastError}`,
  );
}

// ---------------------------------------------------------------------------
// Edit mode: rewrite the selected shapes according to the instruction.
// ---------------------------------------------------------------------------
async function editShapesFromPrompt(
  instruction: string,
  selection: unknown[],
): Promise<unknown[]> {
  const models =
    MODEL_CANDIDATES.length > 0 ? MODEL_CANDIDATES : ["gemini-flash-latest"];
  const prompt = `CURRENT shapes:\n${JSON.stringify(selection)}\n\nINSTRUCTION: ${instruction}`;
  let lastError = "Unknown edit failure";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const modelName of models) {
      try {
        const result = await getModel(modelName, true).generateContent(prompt);
        const rawText = result.response.text();
        const parsed = JSON.parse(extractJsonArrayString(rawText));
        const shapes = validateAndNormalizeShapes(parsed);
        if (shapes.length === 0) {
          throw new Error("The edit removed every shape");
        }
        return shapes;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (isRateLimitError(lastError)) {
          lastError = summarizeQuotaError(lastError).userMessage;
        }
      }
    }
  }

  throw new Error(`AI edit failed: ${lastError}`);
}

// ---------------------------------------------------------------------------
// Post result back to HTTP backend
// ---------------------------------------------------------------------------
async function postResult(
  jobId: string,
  shapes?: unknown[],
  errorMessage?: string,
) {
  await axios.post(
    `${HTTP_BACKEND_INTERNAL_URL}/internal/ai/result`,
    { jobId, shapes, errorMessage },
    {
      headers: {
        "x-internal-secret": INTERNAL_SECRET,
        "Content-Type": "application/json",
      },
      timeout: 10_000,
    },
  );
}

// ---------------------------------------------------------------------------
// Job handler
// ---------------------------------------------------------------------------
async function handleAiJob(job: AiGenerateJob): Promise<void> {
  console.log(
    `[AI Worker] Processing job ${job.jobId} — prompt: "${job.prompt.slice(0, 80)}..."`,
  );

  try {
    const shapes =
      job.mode === "edit" && job.selection && job.selection.length > 0
        ? await editShapesFromPrompt(job.prompt, job.selection)
        : await generateShapesFromPrompt(job.prompt);
    console.log(
      `[AI Worker] Job ${job.jobId} done — generated ${shapes.length} shapes`,
    );
    await postResult(job.jobId, shapes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[AI Worker] Job ${job.jobId} failed:`, message);
    try {
      await postResult(job.jobId, undefined, message);
    } catch (postErr) {
      console.error(
        `[AI Worker] Failed to report error for job ${job.jobId}:`,
        postErr,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
async function start() {
  console.log("[AI Worker] Starting…");
  console.log(`[AI Worker] HTTP backend: ${HTTP_BACKEND_INTERNAL_URL}`);

  await subscribeAiGenerateJobs(handleAiJob);
  console.log("[AI Worker] Subscribed to AI generate queue. Waiting for jobs…");
}

start().catch((err) => {
  console.error("[AI Worker] Fatal startup error:", err);
  process.exit(1);
});
