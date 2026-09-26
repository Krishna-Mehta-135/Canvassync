import { prismaClient, AccessRequestStatus } from "@repo/db/client";
import { ApiError } from "../utils/ApiError";
import { ApiResponse } from "../utils/ApiResponse";
import {
  CreateRoomSchema,
  RenameRoomSlugSchema,
  RoomIdParamSchema,
  RoomHistorySnapshotParamsSchema,
  RoomSlugParamSchema,
  OwnerSlugParamsSchema,
  ReplaceShapesBodySchema,
  RoomAccessRequestCreateSchema,
  RoomAccessRequestDecisionSchema,
  AiGenerateRequestSchema,
  AiGenerateJobIdParamSchema,
  type ChatParticipant,
  type PersistedChatMessage,
} from "@repo/common/types";
import { asyncHandler } from "../utils/asyncHandler";
import { publishAiGenerateJob } from "@repo/queue-sync";
import { randomUUID } from "node:crypto";
import { sharedRedisClient as redisClient } from "@repo/redis-sync";
import { INTERNAL_SECRET } from "@repo/backend-common/config";

function requireUserId(userId?: string) {
  if (!userId) {
    throw new ApiError(401, "Unauthorized: User ID not found");
  }

  return userId;
}

function buildCanonicalRoomPath(room: {
  slug: string;
  admin: { handle: string | null };
}) {
  const handle = room.admin.handle?.trim();

  // Use the owner handle when we have one. Fall back to the slug-only canvas
  // route so invite/open flows still work for accounts that have not set a handle.
  return handle ? `/room/${handle}/${room.slug}` : `/canvas/${room.slug}`;
}

type ChatRecordWithUsers = {
  id: number;
  roomId: number;
  message: string;
  messageType: "GROUP" | "DIRECT" | "COMMENT";
  shapeId: string | null;
  createdAt: Date;
  user: ChatParticipant;
  recipient: ChatParticipant | null;
};

function mapChatParticipant(user: {
  id: string;
  name: string;
  handle: string | null;
  photo?: string | null;
}): ChatParticipant {
  return {
    id: user.id,
    name: user.name,
    handle: user.handle,
    photo: user.photo ?? null,
  };
}

function mapPersistedChatMessage(
  chat: ChatRecordWithUsers,
): PersistedChatMessage {
  return {
    id: chat.id,
    roomId: chat.roomId,
    kind:
      chat.messageType === "DIRECT"
        ? "direct"
        : chat.messageType === "COMMENT"
          ? "comment"
          : "group",
    body: chat.message,
    shapeId: chat.shapeId ?? null,
    createdAt: chat.createdAt.toISOString(),
    sender: chat.user,
    recipient: chat.recipient,
  };
}

async function assertOwnerRoomAccess(roomId: number, userId: string) {
  const room = await prismaClient.room.findFirst({
    where: {
      id: roomId,
      adminId: userId,
    },
    select: {
      id: true,
      adminId: true,
    },
  });

  if (!room) {
    // Return forbidden uniformly to avoid leaking room existence.
    throw new ApiError(403, "Forbidden");
  }

  return room;
}

async function hasRoomAccess(roomId: number, userId: string) {
  const room = await prismaClient.room.findFirst({
    where: {
      id: roomId,
      OR: [
        { adminId: userId },
        {
          members: {
            some: {
              userId,
            },
          },
        },
      ],
    },
    select: {
      id: true,
    },
  });

  return Boolean(room);
}

const createRoom = asyncHandler(async (req, res) => {
  const validationResult = CreateRoomSchema.safeParse(req.body);
  if (!validationResult.success) {
    throw new ApiError(400, "Incorrect input");
  }

  const { slug } = validationResult.data;
  const userId = requireUserId(req.userId);

  try {
    const room = await prismaClient.room.create({
      data: {
        slug,
        adminId: userId,
      },
      include: {
        admin: {
          select: {
            handle: true,
            name: true,
          },
        },
      },
    });

    const canonicalPath = buildCanonicalRoomPath(room);

    return res.status(201).json(
      new ApiResponse(
        201,
        {
          ...room,
          canonicalPath,
        },
        "Room created successfully",
      ),
    );
  } catch (err: unknown) {
    const e = err as { code?: string } | undefined;
    if (e?.code === "P2002") {
      throw new ApiError(409, "Room slug already exists for this user");
    }
    throw err;
  }
});

const listMyRooms = asyncHandler(async (req, res) => {
  const userId = requireUserId(req.userId);

  const rooms = await prismaClient.room.findMany({
    where: {
      adminId: userId,
    },
    orderBy: {
      createdAt: "desc",
    },
    include: {
      admin: {
        select: {
          id: true,
          handle: true,
          name: true,
        },
      },
    },
  });

  const payload = rooms.map((room) => ({
    ...room,
    canonicalPath: buildCanonicalRoomPath(room),
  }));

  res
    .status(200)
    .json(new ApiResponse(200, payload, "Rooms fetched successfully"));
});

const MAX_SHAPES_PER_PAGE = 5000;
const DEFAULT_SHAPES_PER_PAGE = 2000;

/**
 * Parse a viewport query string "x1,y1,x2,y2" into its numeric components.
 * Returns null when the string is absent or malformed.
 */
function parseViewportParam(
  raw: string | undefined,
): { x1: number; y1: number; x2: number; y2: number } | null {
  if (!raw) return null;
  const parts = raw.split(",");
  if (parts.length !== 4) return null;
  const [x1, y1, x2, y2] = parts.map(Number);
  if ([x1, y1, x2, y2].some((n) => !Number.isFinite(n))) return null;
  return { x1: x1!, y1: y1!, x2: x2!, y2: y2! };
}

/**
 * Lists recorded version-history snapshots (newest first) without their
 * payloads so the history panel can render a timeline cheaply.
 */
const listRoomHistory = asyncHandler(async (req, res) => {
  const paramsValidation = RoomIdParamSchema.safeParse(req.params);
  if (!paramsValidation.success) {
    throw new ApiError(400, "Invalid roomId");
  }

  const { roomId } = paramsValidation.data;
  const userId = requireUserId(req.userId);
  if (!(await hasRoomAccess(roomId, userId))) {
    throw new ApiError(403, "Forbidden");
  }

  const snapshots = await prismaClient.roomSnapshot.findMany({
    where: { roomId },
    orderBy: { createdAt: "desc" },
    take: 60,
    select: { id: true, shapeCount: true, createdAt: true },
  });

  res.status(200).json(
    new ApiResponse(200, { snapshots }, "Room history fetched successfully"),
  );
});

const getRoomHistorySnapshot = asyncHandler(async (req, res) => {
  const paramsValidation = RoomHistorySnapshotParamsSchema.safeParse(
    req.params,
  );
  if (!paramsValidation.success) {
    throw new ApiError(400, "Invalid history snapshot");
  }

  const { roomId, snapshotId } = paramsValidation.data;
  const userId = requireUserId(req.userId);
  if (!(await hasRoomAccess(roomId, userId))) {
    throw new ApiError(403, "Forbidden");
  }

  const snapshot = await prismaClient.roomSnapshot.findFirst({
    where: { id: snapshotId, roomId },
    select: { id: true, shapes: true, shapeCount: true, createdAt: true },
  });
  if (!snapshot) {
    throw new ApiError(404, "Snapshot not found");
  }

  res.status(200).json(
    new ApiResponse(200, { snapshot }, "Room history snapshot fetched"),
  );
});

const getShapes = asyncHandler(async (req, res) => {
  const paramsValidation = RoomIdParamSchema.safeParse(req.params);
  if (!paramsValidation.success) {
    throw new ApiError(400, "Invalid roomId");
  }

  const { roomId } = paramsValidation.data;

  const userId = requireUserId(req.userId);
  const canAccess = await hasRoomAccess(roomId, userId);
  if (!canAccess) {
    throw new ApiError(403, "Forbidden");
  }

  // --- Pagination params ---
  const rawLimit = Number(req.query.limit ?? DEFAULT_SHAPES_PER_PAGE);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(MAX_SHAPES_PER_PAGE, rawLimit))
    : DEFAULT_SHAPES_PER_PAGE;

  // cursor is the `createdAt` ISO timestamp of the last shape from the previous page.
  const cursorRaw =
    typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const cursorDate = cursorRaw ? new Date(cursorRaw) : undefined;
  const cursorIsValid = cursorDate && !isNaN(cursorDate.getTime());

  // --- Optional viewport spatial filter ---
  const viewportRaw =
    typeof req.query.viewport === "string" ? req.query.viewport : undefined;
  const viewport = parseViewportParam(viewportRaw);

  try {
    // Build the Prisma where clause.
    // When a viewport is provided we apply a best-effort spatial pre-filter:
    // shapes whose canonical bounding box overlaps the viewport rectangle are
    // included; freehand shapes are always included because their bounds are
    // implicit in a points[] array (too expensive to filter server-side without
    // a precomputed bbox column).
    //
    // The jsonb cast trick works on Postgres >= 12.  On other engines it
    // degrades gracefully by returning all shapes (the `viewport` branch simply
    // won't be entered).

    if (viewport) {
      // Use a raw query so we can leverage Postgres jsonb operators for the
      // spatial filter.  This is safe because all values are parameterised.
      const { x1: vx1, y1: vy1, x2: vx2, y2: vy2 } = viewport;

      // Build cursor clause fragments.
      const cursorClause = cursorIsValid ? `AND s."createdAt" > $7\n` : "";
      const cursorParam = cursorIsValid ? [cursorDate] : [];

      // Shape types with axis-aligned bounding boxes that we can filter cheaply.
      //   rect / rhombus / text  →  x, y, width, height
      //   circle                 →  centerX, centerY, radiusX, radiusY
      //   line / arrow           →  x1, y1, x2, y2
      // All other types (freehand) bypass the spatial filter.
      const spatialFilter = `
                AND (
                    s.type = 'freehand'
                    OR (
                        s.type IN ('rect', 'rhombus', 'text')
                        AND (s.props->>'x')::float8 + (s.props->>'width')::float8 >= $3
                        AND (s.props->>'x')::float8 <= $5
                        AND (s.props->>'y')::float8 + (s.props->>'height')::float8 >= $4
                        AND (s.props->>'y')::float8 <= $6
                    )
                    OR (
                        s.type = 'circle'
                        AND (s.props->>'centerX')::float8 + (s.props->>'radiusX')::float8 >= $3
                        AND (s.props->>'centerX')::float8 - (s.props->>'radiusX')::float8 <= $5
                        AND (s.props->>'centerY')::float8 + (s.props->>'radiusY')::float8 >= $4
                        AND (s.props->>'centerY')::float8 - (s.props->>'radiusY')::float8 <= $6
                    )
                    OR (
                        s.type IN ('line', 'arrow')
                        AND GREATEST((s.props->>'x1')::float8, (s.props->>'x2')::float8) >= $3
                        AND LEAST((s.props->>'x1')::float8, (s.props->>'x2')::float8) <= $5
                        AND GREATEST((s.props->>'y1')::float8, (s.props->>'y2')::float8) >= $4
                        AND LEAST((s.props->>'y1')::float8, (s.props->>'y2')::float8) <= $6
                    )
                )
            `;

      const rows = await prismaClient.$queryRawUnsafe<
        Array<{ props: unknown; createdAt: Date }>
      >(
        `SELECT s.props, s."createdAt"
                 FROM "Shape" s
                 WHERE s."roomId" = $1
                   AND s.deleted = false
                   ${spatialFilter}
                   ${cursorClause}
                 ORDER BY s."createdAt" ASC
                 LIMIT $2`,
        roomId,
        limit + 1, // fetch one extra to detect next page
        vx1,
        vy1,
        vx2,
        vy2,
        ...cursorParam,
      );

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore
        ? pageRows[pageRows.length - 1]?.createdAt?.toISOString()
        : null;

      return res.status(200).json(
        new ApiResponse(
          200,
          {
            shapes: pageRows.map((row) => row.props),
            nextCursor,
          },
          "Shapes fetched successfully",
        ),
      );
    }

    // ---- Non-spatial path: plain cursor-paginated fetch ----
    const shapes = await prismaClient.shape.findMany({
      where: {
        roomId,
        deleted: false,
        ...(cursorIsValid ? { createdAt: { gt: cursorDate } } : {}),
      },
      orderBy: { createdAt: "asc" },
      take: limit + 1,
    });

    const hasMore = shapes.length > limit;
    const pageShapes = hasMore ? shapes.slice(0, limit) : shapes;
    const nextCursor = hasMore
      ? (pageShapes[pageShapes.length - 1]?.createdAt?.toISOString() ?? null)
      : null;

    const serializedShapes = pageShapes.map(
      (shape: { props: unknown }) => shape.props,
    );

    res
      .status(200)
      .json(
        new ApiResponse(
          200,
          { shapes: serializedShapes, nextCursor },
          "Shapes fetched successfully",
        ),
      );
  } catch (err: unknown) {
    // If Prisma schema is out-of-sync (missing table/columns), keep canvas usable.
    const e = err as { code?: string } | undefined;
    if (e?.code === "P2021" || e?.code === "P2022") {
      return res
        .status(200)
        .json(
          new ApiResponse(
            200,
            { shapes: [], nextCursor: null },
            "Shapes unavailable; returned empty state",
          ),
        );
    }
    if (typeof e?.code === "string" && e.code.startsWith("P")) {
      return res
        .status(200)
        .json(
          new ApiResponse(
            200,
            { shapes: [], nextCursor: null },
            "Shapes unavailable; returned empty state",
          ),
        );
    }
    throw err;
  }
});

const getRoomChatBootstrap = asyncHandler(async (req, res) => {
  const paramsValidation = RoomIdParamSchema.safeParse(req.params);
  if (!paramsValidation.success) {
    throw new ApiError(400, "Invalid roomId");
  }

  const { roomId } = paramsValidation.data;
  const userId = requireUserId(req.userId);
  const canAccess = await hasRoomAccess(roomId, userId);
  if (!canAccess) {
    throw new ApiError(403, "Forbidden");
  }

  const room = await prismaClient.room.findUnique({
    where: { id: roomId },
    select: {
      admin: {
        select: {
          id: true,
          name: true,
          handle: true,
          photo: true,
        },
      },
      members: {
        select: {
          user: {
            select: {
              id: true,
              name: true,
              handle: true,
              photo: true,
            },
          },
        },
      },
    },
  });

  if (!room) {
    throw new ApiError(404, "Room not found");
  }

  // Type definition for chat messages with included user and recipient data
  type ChatWithParticipants = {
    id: number;
    roomId: number;
    message: string;
    messageType: "GROUP" | "DIRECT" | "COMMENT";
    shapeId: string | null;
    createdAt: Date;
    updatedAt: Date;
    userId: string;
    recipientId: string | null;
    user: {
      id: string;
      name: string;
      handle: string | null;
      photo: string | null;
    };
    recipient: {
      id: string;
      name: string;
      handle: string | null;
      photo: string | null;
    } | null;
  };

  let groupMessagesRaw: Array<ChatWithParticipants> = [];
  let directMessagesRaw: Array<ChatWithParticipants> = [];
  let commentsRaw: Array<ChatWithParticipants> = [];

  try {
    [groupMessagesRaw, directMessagesRaw, commentsRaw] = await Promise.all([
      prismaClient.chat.findMany({
        where: {
          roomId,
          messageType: "GROUP",
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              handle: true,
              photo: true,
            },
          },
          recipient: {
            select: {
              id: true,
              name: true,
              handle: true,
              photo: true,
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
        take: 80,
      }),
      prismaClient.chat.findMany({
        where: {
          roomId,
          messageType: "DIRECT",
          OR: [{ userId }, { recipientId: userId }],
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              handle: true,
              photo: true,
            },
          },
          recipient: {
            select: {
              id: true,
              name: true,
              handle: true,
              photo: true,
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
        take: 160,
      }),
      prismaClient.chat.findMany({
        where: {
          roomId,
          messageType: "COMMENT",
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              handle: true,
              photo: true,
            },
          },
          recipient: {
            select: {
              id: true,
              name: true,
              handle: true,
              photo: true,
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
        take: 120,
      }),
    ]);
  } catch (error: unknown) {
    const e = error as { code?: string } | undefined;
    if (e?.code !== "P2021" && e?.code !== "P2022") {
      throw error;
    }

    groupMessagesRaw = [];
    directMessagesRaw = [];
    commentsRaw = [];
  }

  const participantsMap = new Map<string, ChatParticipant>();
  participantsMap.set(room.admin.id, mapChatParticipant(room.admin));
  for (const member of room.members) {
    participantsMap.set(member.user.id, mapChatParticipant(member.user));
  }

  const groupMessages = [...groupMessagesRaw]
    .reverse()
    .map((chat: ChatWithParticipants) =>
      mapPersistedChatMessage({
        ...chat,
        user: mapChatParticipant(chat.user),
        recipient: chat.recipient ? mapChatParticipant(chat.recipient) : null,
      }),
    );

  const directMessages = [...directMessagesRaw]
    .reverse()
    .map((chat: ChatWithParticipants) =>
      mapPersistedChatMessage({
        ...chat,
        user: mapChatParticipant(chat.user),
        recipient: chat.recipient ? mapChatParticipant(chat.recipient) : null,
      }),
    );

  const comments = [...commentsRaw]
    .reverse()
    .map((chat: ChatWithParticipants) =>
      mapPersistedChatMessage({
        ...chat,
        user: mapChatParticipant(chat.user),
        recipient: chat.recipient ? mapChatParticipant(chat.recipient) : null,
      }),
    );

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        participants: [...participantsMap.values()],
        groupMessages,
        directMessages,
        comments,
      },
      "Chat bootstrap fetched",
    ),
  );
});

//save the full current canvas snapshot for this room
const replaceShapes = asyncHandler(async (req, res) => {
  const paramsValidation = RoomIdParamSchema.safeParse(req.params);
  if (!paramsValidation.success) {
    throw new ApiError(400, "Invalid roomId");
  }

  const { roomId } = paramsValidation.data;

  const userId = requireUserId(req.userId);
  await assertOwnerRoomAccess(roomId, userId);

  const bodyValidation = ReplaceShapesBodySchema.safeParse(req.body);
  if (!bodyValidation.success) {
    throw new ApiError(400, "Invalid shapes payload");
  }

  const { shapes } = bodyValidation.data;

  try {
    // Deduplicate shapes by ID (keep last occurrence) to avoid unique constraint violations
    const uniqueShapesMap = new Map();
    for (const shape of shapes) {
      uniqueShapesMap.set(shape.id, shape);
    }
    const uniqueShapes = Array.from(uniqueShapesMap.values());

    await prismaClient.$transaction(async (tx) => {
      await tx.shape.deleteMany({
        where: {
          roomId,
        },
      });

      if (uniqueShapes.length > 0) {
        await tx.shape.createMany({
          data: uniqueShapes.map((shape) => ({
            // Database id must be globally unique across all rooms.
            // Keep client shape.id inside props unchanged for canvas logic.
            id: `${roomId}:${shape.id}`,
            roomId,
            type: shape.type,
            props: shape,
            deleted: false,
          })),
          skipDuplicates: true,
        });
      }
    });
  } catch (err: unknown) {
    const e = err as { code?: string } | undefined;
    if (e?.code === "P2021" || e?.code === "P2022") {
      throw new ApiError(
        503,
        "Shape storage is not ready. Run database migrations/push first.",
      );
    }

    if (e?.code === "P2003") {
      throw new ApiError(404, "Room not found for provided roomId");
    }

    if (typeof e?.code === "string" && e.code.startsWith("P")) {
      console.error(
        `Prisma error ${e.code} while persisting shapes for roomId ${roomId}:`,
        err,
      );
      throw new ApiError(503, "Shape storage is temporarily unavailable");
    }

    throw err;
  }

  res.status(200).json(new ApiResponse(200, null, "Shapes saved successfully"));
});

const getRoomIdFromSlug = asyncHandler(async (req, res) => {
  const paramsValidation = RoomSlugParamSchema.safeParse(req.params);
  if (!paramsValidation.success) {
    throw new ApiError(400, "Invalid slug");
  }

  const userId = requireUserId(req.userId);
  const { slug } = paramsValidation.data;

  const room = await prismaClient.room.findFirst({
    where: {
      adminId: userId,
      slug,
    },
    include: {
      admin: {
        select: {
          id: true,
          handle: true,
          name: true,
        },
      },
    },
  });

  if (!room) {
    throw new ApiError(404, "Room not found");
  }

  res.status(200).json(
    new ApiResponse(
      200,
      {
        ...room,
        canonicalPath: buildCanonicalRoomPath(room),
      },
      "RoomId successfully fetched from slug",
    ),
  );
});

const getRoomByOwnerAndSlug = asyncHandler(async (req, res) => {
  const paramsValidation = OwnerSlugParamsSchema.safeParse(req.params);
  if (!paramsValidation.success) {
    throw new ApiError(400, "Invalid room route parameters");
  }

  const userId = requireUserId(req.userId);
  const { userHandle: ownerHandle, slug } = paramsValidation.data;

  const room = await prismaClient.room.findFirst({
    where: {
      slug,
      admin: {
        handle: ownerHandle,
      },
      OR: [
        { adminId: userId },
        {
          members: {
            some: {
              userId,
            },
          },
        },
      ],
    },
    include: {
      admin: {
        select: {
          id: true,
          name: true,
          handle: true,
        },
      },
    },
  });

  if (!room) {
    throw new ApiError(403, "Forbidden");
  }

  res.status(200).json(
    new ApiResponse(
      200,
      {
        ...room,
        canonicalPath: buildCanonicalRoomPath(room),
      },
      "Room fetched successfully",
    ),
  );
});

const renameRoomSlug = asyncHandler(async (req, res) => {
  const paramsValidation = RoomIdParamSchema.safeParse(req.params);
  if (!paramsValidation.success) {
    throw new ApiError(400, "Invalid roomId");
  }

  const { roomId } = paramsValidation.data;

  const validationResult = RenameRoomSlugSchema.safeParse(req.body);
  if (!validationResult.success) {
    throw new ApiError(400, "Incorrect input");
  }

  const userId = requireUserId(req.userId);
  await assertOwnerRoomAccess(roomId, userId);

  try {
    const updatedRoom = await prismaClient.room.update({
      where: { id: roomId },
      data: {
        slug: validationResult.data.slug,
      },
      include: {
        admin: {
          select: {
            id: true,
            handle: true,
            name: true,
          },
        },
      },
    });

    res.status(200).json(
      new ApiResponse(
        200,
        {
          ...updatedRoom,
          canonicalPath: buildCanonicalRoomPath(updatedRoom),
        },
        "Room slug updated successfully",
      ),
    );
  } catch (err: unknown) {
    const e = err as { code?: string } | undefined;
    if (e?.code === "P2002") {
      throw new ApiError(409, "Room slug already exists for this user");
    }
    throw err;
  }
});

const getInviteLink = asyncHandler(async (req, res) => {
  const paramsValidation = RoomIdParamSchema.safeParse(req.params);
  if (!paramsValidation.success) {
    throw new ApiError(400, "Invalid roomId");
  }

  const userId = requireUserId(req.userId);
  const { roomId } = paramsValidation.data;

  await assertOwnerRoomAccess(roomId, userId);

  const room = await prismaClient.room.findUnique({
    where: {
      id: roomId,
    },
    include: {
      admin: {
        select: {
          handle: true,
          name: true,
        },
      },
    },
  });

  if (!room) {
    throw new ApiError(403, "Forbidden");
  }

  const inviteLink = `${req.protocol}://${req.get("host")}${buildCanonicalRoomPath(room)}`;

  res.status(200).json(
    new ApiResponse(
      200,
      {
        inviteLink,
        canonicalPath: buildCanonicalRoomPath(room),
        roomSlug: room.slug,
      },
      "Invite link generated successfully",
    ),
  );
});

const requestRoomAccess = asyncHandler(async (req, res) => {
  const validationResult = RoomAccessRequestCreateSchema.safeParse(req.body);
  if (!validationResult.success) {
    throw new ApiError(400, "Invalid access request payload");
  }

  const requesterId = requireUserId(req.userId);
  const { ownerHandle, slug, note } = validationResult.data;

  const room = await prismaClient.room.findFirst({
    where: {
      slug,
      admin: {
        handle: ownerHandle,
      },
    },
    include: {
      admin: {
        select: {
          id: true,
          handle: true,
          name: true,
        },
      },
    },
  });

  if (!room) {
    throw new ApiError(404, "Room not found");
  }

  if (room.adminId === requesterId) {
    throw new ApiError(400, "You already own this room");
  }

  const existingMembership = await prismaClient.roomMember.findUnique({
    where: {
      roomId_userId: {
        roomId: room.id,
        userId: requesterId,
      },
    },
  });

  if (existingMembership) {
    return res.status(200).json(
      new ApiResponse(
        200,
        {
          roomId: room.id,
          status: AccessRequestStatus.APPROVED.toLowerCase(),
        },
        "You already have access to this room",
      ),
    );
  }

  const existingRequest = await prismaClient.roomAccessRequest.findUnique({
    where: {
      roomId_requesterId: {
        roomId: room.id,
        requesterId,
      },
    },
  });

  if (
    existingRequest &&
    existingRequest.status === AccessRequestStatus.PENDING
  ) {
    return res.status(200).json(
      new ApiResponse(
        200,
        {
          requestId: existingRequest.id,
          roomId: room.id,
          status: existingRequest.status.toLowerCase(),
        },
        "Access request already pending",
      ),
    );
  }

  const nextRequest = existingRequest
    ? await prismaClient.roomAccessRequest.update({
        where: {
          id: existingRequest.id,
        },
        data: {
          status: AccessRequestStatus.PENDING,
          decisionNote: note,
          respondedAt: null,
        },
      })
    : await prismaClient.roomAccessRequest.create({
        data: {
          roomId: room.id,
          requesterId,
          status: AccessRequestStatus.PENDING,
          decisionNote: note,
        },
      });

  res.status(201).json(
    new ApiResponse(
      201,
      {
        requestId: nextRequest.id,
        roomId: room.id,
        status: nextRequest.status.toLowerCase(),
      },
      "Access request sent to room owner",
    ),
  );
});

const listIncomingRoomAccessRequests = asyncHandler(async (req, res) => {
  const ownerId = requireUserId(req.userId);

  const requests = await prismaClient.roomAccessRequest.findMany({
    where: {
      status: AccessRequestStatus.PENDING,
      room: {
        adminId: ownerId,
      },
    },
    include: {
      room: {
        select: {
          id: true,
          slug: true,
          admin: {
            select: {
              handle: true,
              name: true,
            },
          },
        },
      },
      requester: {
        select: {
          id: true,
          name: true,
          handle: true,
          email: true,
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  res
    .status(200)
    .json(new ApiResponse(200, requests, "Incoming access requests fetched"));
});

const decideRoomAccessRequest = asyncHandler(async (req, res) => {
  const validationResult = RoomAccessRequestDecisionSchema.safeParse(req.body);
  if (!validationResult.success) {
    throw new ApiError(400, "Invalid access decision payload");
  }

  const ownerId = requireUserId(req.userId);
  const { requestId, action, note } = validationResult.data;

  const accessRequest = await prismaClient.roomAccessRequest.findUnique({
    where: {
      id: requestId,
    },
    include: {
      room: {
        select: {
          id: true,
          adminId: true,
        },
      },
    },
  });

  if (!accessRequest) {
    throw new ApiError(404, "Access request not found");
  }

  if (accessRequest.room.adminId !== ownerId) {
    throw new ApiError(403, "Forbidden");
  }

  if (accessRequest.status !== AccessRequestStatus.PENDING) {
    throw new ApiError(409, "Access request is already resolved");
  }

  await prismaClient.$transaction(async (tx) => {
    await tx.roomAccessRequest.update({
      where: {
        id: accessRequest.id,
      },
      data: {
        status:
          action === "approve"
            ? AccessRequestStatus.APPROVED
            : AccessRequestStatus.REJECTED,
        respondedAt: new Date(),
        decisionNote: note,
      },
    });

    if (action === "approve") {
      await tx.roomMember.upsert({
        where: {
          roomId_userId: {
            roomId: accessRequest.room.id,
            userId: accessRequest.requesterId,
          },
        },
        create: {
          roomId: accessRequest.room.id,
          userId: accessRequest.requesterId,
        },
        update: {},
      });
    }
  });

  res.status(200).json(
    new ApiResponse(
      200,
      {
        requestId: accessRequest.id,
        action,
      },
      `Access request ${action}d`,
    ),
  );
});

// ---------------------------------------------------------------------------
// AI job store (Redis-backed for multi-node scalability)
// ---------------------------------------------------------------------------
type AiJobStatus = "pending" | "done" | "error";

interface AiJobEntry {
  status: AiJobStatus;
  roomId: number;
  shapes?: unknown[];
  summary?: string;
  errorMessage?: string;
  createdAt: number;
}

const getAiJobKey = (jobId: string) => `ai:job:${jobId}`;
const AI_JOB_TTL_SEC = 300; // 5 minutes

// ---------------------------------------------------------------------------
// AI controller functions
// ---------------------------------------------------------------------------

// POST /room/:roomId/ai/generate
const generateAiCanvas = asyncHandler(async (req, res) => {
  const paramsValidation = RoomIdParamSchema.safeParse(req.params);
  if (!paramsValidation.success) {
    throw new ApiError(400, "Invalid roomId");
  }

  const { roomId } = paramsValidation.data;
  const userId = requireUserId(req.userId);

  const canAccess = await hasRoomAccess(roomId, userId);
  if (!canAccess) {
    throw new ApiError(403, "Forbidden");
  }

  const bodyValidation = AiGenerateRequestSchema.safeParse(req.body);
  if (!bodyValidation.success) {
    throw new ApiError(
      400,
      "Invalid request — prompt must be 1–12000 characters; edit mode needs a selection",
    );
  }

  const { prompt, mode, selection } = bodyValidation.data;
  const jobId = randomUUID();

  const initialEntry: AiJobEntry = {
    status: "pending",
    roomId,
    createdAt: Date.now(),
  };

  await redisClient.set(
    getAiJobKey(jobId),
    JSON.stringify(initialEntry),
    "EX",
    AI_JOB_TTL_SEC,
  );

  try {
    await publishAiGenerateJob({
      jobId,
      roomId,
      prompt,
      mode,
      selection: selection as Record<string, unknown>[] | undefined,
      requestedBy: userId,
      enqueuedAtMs: Date.now(),
    });
  } catch {
    const errorEntry: AiJobEntry = {
      status: "error",
      roomId,
      errorMessage: "Failed to enqueue AI job",
      createdAt: Date.now(),
    };
    await redisClient.set(
      getAiJobKey(jobId),
      JSON.stringify(errorEntry),
      "EX",
      AI_JOB_TTL_SEC,
    );
    throw new ApiError(
      503,
      "AI generation queue is unavailable. Please try again.",
    );
  }

  return res
    .status(202)
    .json(new ApiResponse(202, { jobId }, "AI generation started"));
});

// GET /room/:roomId/ai/generate/:jobId
const getAiGenerateStatus = asyncHandler(async (req, res) => {
  const paramsValidation = RoomIdParamSchema.safeParse(req.params);
  if (!paramsValidation.success) {
    throw new ApiError(400, "Invalid roomId");
  }

  const jobParamsValidation = AiGenerateJobIdParamSchema.safeParse(req.params);
  if (!jobParamsValidation.success) {
    throw new ApiError(400, "Invalid jobId");
  }

  const { jobId } = jobParamsValidation.data;
  const { roomId } = paramsValidation.data;
  const userId = requireUserId(req.userId);

  const canAccess = await hasRoomAccess(roomId, userId);
  if (!canAccess) {
    throw new ApiError(403, "Forbidden");
  }

  const rawEntry = await redisClient.get(getAiJobKey(jobId));
  if (!rawEntry) {
    throw new ApiError(404, "Job not found or expired");
  }

  const entry = JSON.parse(rawEntry) as AiJobEntry;

  if (entry.roomId !== roomId) {
    throw new ApiError(403, "Forbidden");
  }

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        jobId,
        status: entry.status,
        shapes: entry.shapes ?? null,
        summary: entry.summary ?? null,
        errorMessage: entry.errorMessage ?? null,
      },
      "Job status fetched",
    ),
  );
});

// POST /internal/ai/result  — called by AI worker only, guarded by shared secret
const receiveAiResult = asyncHandler(async (req, res) => {
  const secret = req.headers["x-internal-secret"];
  if (secret !== INTERNAL_SECRET) {
    throw new ApiError(403, "Forbidden");
  }

  const { jobId, shapes, summary, errorMessage } = req.body as {
    jobId?: string;
    shapes?: unknown[];
    summary?: string;
    errorMessage?: string;
  };

  if (typeof jobId !== "string") {
    throw new ApiError(400, "Missing or invalid jobId");
  }

  const rawEntry = await redisClient.get(getAiJobKey(jobId));
  if (!rawEntry) {
    return res
      .status(200)
      .json(new ApiResponse(200, null, "Job not found (may have expired)"));
  }

  const entry = JSON.parse(rawEntry) as AiJobEntry;

  if (errorMessage) {
    const nextEntry: AiJobEntry = { ...entry, status: "error", errorMessage };
    await redisClient.set(
      getAiJobKey(jobId),
      JSON.stringify(nextEntry),
      "EX",
      AI_JOB_TTL_SEC,
    );
  } else {
    const nextEntry: AiJobEntry = {
      ...entry,
      status: "done",
      shapes: shapes ?? [],
      ...(typeof summary === "string" ? { summary } : {}),
    };
    await redisClient.set(
      getAiJobKey(jobId),
      JSON.stringify(nextEntry),
      "EX",
      AI_JOB_TTL_SEC,
    );
  }

  return res.status(200).json(new ApiResponse(200, null, "AI result received"));
});

export {
  createRoom,
  listMyRooms,
  getShapes,
  listRoomHistory,
  getRoomHistorySnapshot,
  getRoomChatBootstrap,
  replaceShapes,
  getRoomIdFromSlug,
  getRoomByOwnerAndSlug,
  renameRoomSlug,
  getInviteLink,
  requestRoomAccess,
  listIncomingRoomAccessRequests,
  decideRoomAccessRequest,
  generateAiCanvas,
  getAiGenerateStatus,
  receiveAiResult,
};
