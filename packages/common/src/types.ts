import { z } from "zod";

export const ROOM_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const RoomSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(32)
  .regex(
    ROOM_SLUG_REGEX,
    "Room slug must use lowercase letters, numbers, and hyphens only",
  );

export const CreateUserSchema = z.object({
  email: z.email(),
  password: z.string(),
  name: z.string(),
});

export const SignInUserSchema = z.object({
  email: z.email(),
  password: z.string(),
});

export const CreateRoomSchema = z.object({
  slug: RoomSlugSchema,
});

export const RenameRoomSlugSchema = z.object({
  slug: RoomSlugSchema,
});

export const RoomIdParamSchema = z.object({
  roomId: z.coerce.number().int().positive(),
});

export const RoomHistorySnapshotParamsSchema = z.object({
  roomId: z.coerce.number().int().positive(),
  snapshotId: z.coerce.number().int().positive(),
});

export const RoomSlugParamSchema = z.object({
  slug: RoomSlugSchema,
});

export const UserHandleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(32)
  .regex(
    ROOM_SLUG_REGEX,
    "User handle must use lowercase letters, numbers, and hyphens only",
  );

export const OwnerSlugParamsSchema = z.object({
  userHandle: UserHandleSchema,
  slug: RoomSlugSchema,
});

export const CanvasShapeSchema = z
  .object({
    id: z.string().min(1).max(200),
    type: z.string().min(1).max(64),
  })
  .passthrough();

export const ReplaceShapesBodySchema = z.object({
  shapes: z.array(CanvasShapeSchema).max(5000),
});

export const RoomAccessRequestCreateSchema = z.object({
  ownerHandle: UserHandleSchema,
  slug: RoomSlugSchema,
  note: z.string().trim().max(500).optional(),
});

export const RoomAccessRequestDecisionSchema = z.object({
  requestId: z.coerce.number().int().positive(),
  action: z.enum(["approve", "reject"]),
  note: z.string().trim().max(500).optional(),
});

// AI canvas generation
export const AiGenerateRequestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(12000), // extended to allow canvas context JSON
    // "edit" rewrites `selection` according to `prompt` instead of adding new shapes;
    // "summarize" turns `selection` (the board's shapes) into a text summary.
    mode: z.enum(["generate", "edit", "summarize"]).optional(),
    selection: z.array(CanvasShapeSchema).max(120).optional(),
  })
  .refine(
    (value) =>
      (value.mode !== "edit" && value.mode !== "summarize") ||
      (value.selection?.length ?? 0) > 0,
    {
      message: "edit and summarize modes require a non-empty selection",
      path: ["selection"],
    },
  );

export const AiGenerateJobIdParamSchema = z.object({
  jobId: z.string().min(8).max(128),
});

export const ChatParticipantSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  handle: z.string().min(1).max(200).nullable(),
  photo: z.string().min(1).max(2048).nullable().optional(),
});

export type ChatParticipant = z.infer<typeof ChatParticipantSchema>;

export const ChatMessageKindSchema = z.enum(["group", "direct", "comment"]);

export type ChatMessageKind = z.infer<typeof ChatMessageKindSchema>;

export const PersistedChatMessageSchema = z.object({
  id: z.number().int().positive(),
  roomId: z.number().int().positive(),
  kind: ChatMessageKindSchema,
  body: z.string().min(1).max(4000),
  shapeId: z.string().min(1).max(200).nullable(),
  createdAt: z.string().min(1).max(64),
  sender: ChatParticipantSchema,
  recipient: ChatParticipantSchema.nullable(),
});

export type PersistedChatMessage = z.infer<typeof PersistedChatMessageSchema>;

export const RoomChatBootstrapSchema = z.object({
  participants: z.array(ChatParticipantSchema),
  groupMessages: z.array(PersistedChatMessageSchema),
  directMessages: z.array(PersistedChatMessageSchema),
  comments: z.array(PersistedChatMessageSchema),
});

export type RoomChatBootstrap = z.infer<typeof RoomChatBootstrapSchema>;
