import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import { idempotencyMiddleware } from "../middlewares/idempotency.middleware";
import {
  createRoom,
  listMyRooms,
  getShapes,
  listRoomHistory,
  getRoomHistorySnapshot,
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

const roomRouter: Router = Router();

roomRouter.post("/", authenticate, idempotencyMiddleware, createRoom);
roomRouter.get("/mine", authenticate, listMyRooms);
roomRouter.get("/:roomId/chat/bootstrap", authenticate, getRoomChatBootstrap);
roomRouter.get("/:roomId/shapes", authenticate, getShapes);
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
