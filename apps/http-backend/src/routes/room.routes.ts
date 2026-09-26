import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import { idempotencyMiddleware } from "../middlewares/idempotency.middleware";
import {
  createRoom,
  listMyRooms,
  getShapes,
  listRoomHistory,
  getRoomHistorySnapshot,
  listRoomMembers,
  updateRoomMemberRole,
  removeRoomMember,
  getRoomIdFromSlug,
  getRoomByOwnerAndSlug,
  replaceShapes,
  renameRoomSlug,
  getInviteLink,
  getRoomChatBootstrap,
  requestRoomAccess,
  listIncomingRoomAccessRequests,
  decideRoomAccessRequest,
  generateAiCanvas,
  getAiGenerateStatus,
} from "../controllers/room.controller";

import {
  getPublicLinkStatus,
  enablePublicLink,
  disablePublicLink,
} from "../controllers/public.controller";

const roomRouter: Router = Router();

roomRouter.post("/", authenticate, idempotencyMiddleware, createRoom);
roomRouter.get("/mine", authenticate, listMyRooms);
roomRouter.get("/:roomId/chat/bootstrap", authenticate, getRoomChatBootstrap);
roomRouter.get("/:roomId/shapes", authenticate, getShapes);
roomRouter.get("/:roomId/public", authenticate, getPublicLinkStatus);
roomRouter.post("/:roomId/public", authenticate, enablePublicLink);
roomRouter.delete("/:roomId/public", authenticate, disablePublicLink);
roomRouter.get("/:roomId/members", authenticate, listRoomMembers);
roomRouter.patch(
  "/:roomId/members/:userId",
  authenticate,
  idempotencyMiddleware,
  updateRoomMemberRole,
);
roomRouter.delete("/:roomId/members/:userId", authenticate, removeRoomMember);
roomRouter.get("/:roomId/history", authenticate, listRoomHistory);
roomRouter.get(
  "/:roomId/history/:snapshotId",
  authenticate,
  getRoomHistorySnapshot,
);
roomRouter.put(
  "/:roomId/shapes",
  authenticate,
  idempotencyMiddleware,
  replaceShapes,
);
roomRouter.get("/room/slug/:slug", authenticate, getRoomIdFromSlug);
roomRouter.get(
  "/resolve/:userHandle/:slug",
  authenticate,
  getRoomByOwnerAndSlug,
);
roomRouter.patch(
  "/:roomId/slug",
  authenticate,
  idempotencyMiddleware,
  renameRoomSlug,
);
roomRouter.get("/:roomId/invite", authenticate, getInviteLink);
roomRouter.post(
  "/access/request",
  authenticate,
  idempotencyMiddleware,
  requestRoomAccess,
);
roomRouter.get(
  "/access/requests/incoming",
  authenticate,
  listIncomingRoomAccessRequests,
);
roomRouter.post(
  "/access/requests/decision",
  authenticate,
  idempotencyMiddleware,
  decideRoomAccessRequest,
);

// AI canvas generation
roomRouter.post("/:roomId/ai/generate", authenticate, generateAiCanvas);
roomRouter.get(
  "/:roomId/ai/generate/:jobId",
  authenticate,
  getAiGenerateStatus,
);

export { roomRouter };
