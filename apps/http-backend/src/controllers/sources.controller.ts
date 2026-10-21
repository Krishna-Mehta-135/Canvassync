import { prismaClient } from "@repo/db/client";
import {
  AddSourceSchema,
  MAX_SOURCE_CHARS,
  RoomIdParamSchema,
  SourceIdParamSchema,
} from "@repo/common/types";
import { ApiError } from "../utils/ApiError";
import { ApiResponse } from "../utils/ApiResponse";
import { asyncHandler } from "../utils/asyncHandler";
import { indexSource, suggestQuestions } from "../utils/rag";

// File intent: Manage per-canvas reference sources (RAG corpus) and suggested questions.

const MAX_SOURCES_PER_ROOM = 12;

async function requireRoomAccess(roomId: number, userId?: string) {
  if (!userId) throw new ApiError(401, "Unauthorized: User ID not found");
  const room = await prismaClient.room.findFirst({
    where: {
      id: roomId,
      OR: [{ adminId: userId }, { members: { some: { userId } } }],
    },
    select: { id: true },
  });
  if (!room) throw new ApiError(403, "Forbidden");
  return userId;
}

function parseRoomId(params: unknown) {
  const parsed = RoomIdParamSchema.safeParse(params);
  if (!parsed.success) throw new ApiError(400, "Invalid roomId");
  return parsed.data.roomId;
}

// GET /room/:roomId/sources
const listSources = asyncHandler(async (req, res) => {
  const roomId = parseRoomId(req.params);
  await requireRoomAccess(roomId, req.userId);

  const sources = await prismaClient.roomSource.findMany({
    where: { roomId },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, charCount: true, createdAt: true },
  });
  return res.status(200).json(new ApiResponse(200, { sources }, "Sources"));
});

// POST /room/:roomId/sources
const addSource = asyncHandler(async (req, res) => {
  const roomId = parseRoomId(req.params);
  const userId = await requireRoomAccess(roomId, req.userId);

  const body = AddSourceSchema.safeParse(req.body);
  if (!body.success) {
    throw new ApiError(
      400,
      `Invalid source — needs a name and 20 to ${MAX_SOURCE_CHARS} characters of text`,
    );
  }

  const existing = await prismaClient.roomSource.count({ where: { roomId } });
  if (existing >= MAX_SOURCES_PER_ROOM) {
    throw new ApiError(
      400,
      `A canvas can hold up to ${MAX_SOURCES_PER_ROOM} sources — remove one first`,
    );
  }

  let source;
  try {
    source = await indexSource({ roomId, userId, ...body.data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("no readable text")) throw new ApiError(400, message);
    throw new ApiError(502, "Could not index the source. Please try again.");
  }
  return res.status(201).json(new ApiResponse(201, { source }, "Source added"));
});

// DELETE /room/:roomId/sources/:sourceId
const deleteSource = asyncHandler(async (req, res) => {
  const params = SourceIdParamSchema.safeParse(req.params);
  if (!params.success) throw new ApiError(400, "Invalid source");
  const { roomId, sourceId } = params.data;
  await requireRoomAccess(roomId, req.userId);

  const result = await prismaClient.roomSource.deleteMany({
    where: { id: sourceId, roomId },
  });
  if (result.count === 0) throw new ApiError(404, "Source not found");
  return res.status(200).json(new ApiResponse(200, {}, "Source removed"));
});

// GET /room/:roomId/sources/suggestions
const getSourceSuggestions = asyncHandler(async (req, res) => {
  const roomId = parseRoomId(req.params);
  await requireRoomAccess(roomId, req.userId);

  let questions: string[];
  try {
    questions = await suggestQuestions(roomId);
  } catch {
    throw new ApiError(502, "Could not generate suggestions. Please try again.");
  }
  return res
    .status(200)
    .json(new ApiResponse(200, { questions }, "Suggested questions"));
});

export { listSources, addSource, deleteSource, getSourceSuggestions };
