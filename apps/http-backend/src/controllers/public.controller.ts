import { randomBytes } from "node:crypto";
import { prismaClient } from "@repo/db/client";
import { RoomIdParamSchema } from "@repo/common/types";
import { ApiError } from "../utils/ApiError";
import { ApiResponse } from "../utils/ApiResponse";
import { asyncHandler } from "../utils/asyncHandler";

// Read-only public share links. The token is the only credential, so it is long,
// random, revocable (disable) and rotatable.

const PUBLIC_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;

const MAX_PUBLIC_SHAPES = 5000;

function requireUserId(userId: string | undefined) {
  if (!userId) throw new ApiError(401, "Unauthorized");
  return userId;
}

async function assertRoomOwner(roomId: number, userId: string) {
  const room = await prismaClient.room.findFirst({
    where: { id: roomId, adminId: userId },
    select: { id: true, publicToken: true },
  });
  if (!room) {
    // Uniform response so room existence is not leaked.
    throw new ApiError(403, "Forbidden");
  }
  return room;
}

function newToken() {
  return randomBytes(24).toString("base64url");
}

// GET /room/:roomId/public — owner: is a public link active?
const getPublicLinkStatus = asyncHandler(async (req, res) => {
  const params = RoomIdParamSchema.safeParse(req.params);
  if (!params.success) throw new ApiError(400, "Invalid roomId");

  const room = await assertRoomOwner(
    params.data.roomId,
    requireUserId(req.userId),
  );

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { enabled: Boolean(room.publicToken), token: room.publicToken },
        "Public link status fetched",
      ),
    );
});

// POST /room/:roomId/public — owner: enable (or rotate with { rotate: true }).
const enablePublicLink = asyncHandler(async (req, res) => {
  const params = RoomIdParamSchema.safeParse(req.params);
  if (!params.success) throw new ApiError(400, "Invalid roomId");

  const room = await assertRoomOwner(
    params.data.roomId,
    requireUserId(req.userId),
  );
  const rotate = req.body?.rotate === true;

  const token =
    room.publicToken && !rotate
      ? room.publicToken
      : newToken();

  if (token !== room.publicToken) {
    await prismaClient.room.update({
      where: { id: room.id },
      data: { publicToken: token },
    });
  }

  return res
    .status(200)
    .json(new ApiResponse(200, { enabled: true, token }, "Public link enabled"));
});

// DELETE /room/:roomId/public — owner: revoke the link.
const disablePublicLink = asyncHandler(async (req, res) => {
  const params = RoomIdParamSchema.safeParse(req.params);
  if (!params.success) throw new ApiError(400, "Invalid roomId");

  const room = await assertRoomOwner(
    params.data.roomId,
    requireUserId(req.userId),
  );
  await prismaClient.room.update({
    where: { id: room.id },
    data: { publicToken: null },
  });

  return res
    .status(200)
    .json(
      new ApiResponse(200, { enabled: false, token: null }, "Public link disabled"),
    );
});

// GET /public/board/:token — no auth. Only exposes the room name, owner name and shapes.
const getPublicBoard = asyncHandler(async (req, res) => {
  const token = String(req.params.token ?? "");
  if (!PUBLIC_TOKEN_PATTERN.test(token)) {
    throw new ApiError(404, "Board not found");
  }

  const room = await prismaClient.room.findUnique({
    where: { publicToken: token },
    select: {
      id: true,
      slug: true,
      admin: { select: { name: true, handle: true } },
    },
  });
  if (!room) throw new ApiError(404, "Board not found");

  const rows = await prismaClient.shape.findMany({
    where: { roomId: room.id, deleted: false },
    orderBy: { createdAt: "asc" },
    take: MAX_PUBLIC_SHAPES,
    select: { props: true },
  });

  res.setHeader("Cache-Control", "public, max-age=5");
  return res.status(200).json(
    new ApiResponse(
      200,
      {
        room: {
          slug: room.slug,
          ownerName: room.admin.name,
          ownerHandle: room.admin.handle,
        },
        shapes: rows.map((row) => row.props),
      },
      "Public board fetched",
    ),
  );
});

export {
  getPublicLinkStatus,
  enablePublicLink,
  disablePublicLink,
  getPublicBoard,
};
