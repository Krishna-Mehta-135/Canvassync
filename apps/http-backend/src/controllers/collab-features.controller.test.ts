import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { prismaClient } from "@repo/db/client";
import { mockDeep, mockReset } from "vitest-mock-extended";
import {
  disablePublicLink,
  enablePublicLink,
  getPublicBoard,
  getPublicLinkStatus,
} from "./public.controller";
import {
  getRoomHistorySnapshot,
  listRoomHistory,
  listRoomMembers,
  removeRoomMember,
  updateRoomMemberRole,
  decideRoomAccessRequest,
  replaceShapes,
  listRoomSlides,
  replaceRoomSlides,
} from "./room.controller";

vi.mock("@repo/db/client", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return {
    prismaClient: mockDeep<any>(),
    AccessRequestStatus: { PENDING: "PENDING", APPROVED: "APPROVED", REJECTED: "REJECTED" },
  };
});
vi.mock("@repo/queue-sync", () => ({ publishAiGenerateJob: vi.fn() }));
vi.mock("@repo/redis-sync", () => ({
  sharedRedisClient: { get: vi.fn(), set: vi.fn(), on: vi.fn() },
}));
vi.mock("@repo/backend-common/config", () => ({
  INTERNAL_SECRET: "test-secret",
  REDIS_URL: "redis://localhost:6379",
}));

const db = prismaClient as any;
const OWNER = "owner-1";
const TOKEN = "A".repeat(32);

function makeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as unknown as Response & { status: any; json: any; setHeader: any };
}
const call = (handler: any, req: Partial<Request>, res: Response) =>
  handler(req as Request, res, vi.fn());

beforeEach(() => mockReset(db));

describe("public view link", () => {
  it("only lets the owner create a link, and returns a long random token", async () => {
    db.room.findFirst.mockResolvedValue({ id: 1, publicToken: null });
    db.room.update.mockResolvedValue({});
    const res = makeRes();
    await call(enablePublicLink, { params: { roomId: "1" }, userId: OWNER, body: {} } as any, res);

    const token = db.room.update.mock.calls[0][0].data.publicToken as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(db.room.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1, adminId: OWNER } }),
    );
  });

  it("keeps the existing token unless rotate is requested", async () => {
    db.room.findFirst.mockResolvedValue({ id: 1, publicToken: TOKEN });
    const res = makeRes();
    await call(enablePublicLink, { params: { roomId: "1" }, userId: OWNER, body: {} } as any, res);
    expect(db.room.update).not.toHaveBeenCalled();

    const rotated = makeRes();
    db.room.update.mockResolvedValue({});
    await call(enablePublicLink, { params: { roomId: "1" }, userId: OWNER, body: { rotate: true } } as any, rotated);
    expect(db.room.update.mock.calls[0][0].data.publicToken).not.toBe(TOKEN);
  });

  it("rejects non-owners with 403 for status, enable and disable", async () => {
    db.room.findFirst.mockResolvedValue(null);
    for (const handler of [getPublicLinkStatus, enablePublicLink, disablePublicLink]) {
      const res = makeRes();
      await call(handler, { params: { roomId: "1" }, userId: "intruder", body: {} } as any, res);
      expect(res.status).toHaveBeenCalledWith(403);
    }
    expect(db.room.update).not.toHaveBeenCalled();
  });

  it("disable clears the token", async () => {
    db.room.findFirst.mockResolvedValue({ id: 1, publicToken: TOKEN });
    db.room.update.mockResolvedValue({});
    await call(disablePublicLink, { params: { roomId: "1" }, userId: OWNER } as any, makeRes());
    expect(db.room.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { publicToken: null } });
  });

  it("serves a board without auth and exposes only safe fields", async () => {
    db.room.findUnique.mockResolvedValue({ id: 1, slug: "demo", admin: { name: "Alice", handle: "alice" } });
    db.shape.findMany.mockResolvedValue([{ props: { id: "s1", type: "rect" } }]);
    const res = makeRes();
    await call(getPublicBoard, { params: { token: TOKEN } } as any, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0];
    expect(payload.data).toEqual({
      room: { slug: "demo", ownerName: "Alice", ownerHandle: "alice" },
      shapes: [{ id: "s1", type: "rect" }],
    });
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "public, max-age=5");
  });

  it("404s for malformed and unknown tokens without hitting the database for the former", async () => {
    const bad = makeRes();
    await call(getPublicBoard, { params: { token: "short" } } as any, bad);
    expect(bad.status).toHaveBeenCalledWith(404);
    expect(db.room.findUnique).not.toHaveBeenCalled();

    db.room.findUnique.mockResolvedValue(null);
    const unknown = makeRes();
    await call(getPublicBoard, { params: { token: TOKEN } } as any, unknown);
    expect(unknown.status).toHaveBeenCalledWith(404);
  });
});

describe("member roles", () => {
  it("lists members for the owner only", async () => {
    db.room.findFirst.mockResolvedValue({ id: 1, adminId: OWNER });
    db.roomMember.findMany.mockResolvedValue([
      { role: "VIEWER", user: { id: "u2", name: "Bob", handle: "bob" } },
    ]);
    const res = makeRes();
    await call(listRoomMembers, { params: { roomId: "1" }, userId: OWNER } as any, res);
    expect(res.json.mock.calls[0][0].data.members).toEqual([
      { userId: "u2", name: "Bob", handle: "bob", role: "VIEWER" },
    ]);

    db.room.findFirst.mockResolvedValue(null);
    const denied = makeRes();
    await call(listRoomMembers, { params: { roomId: "1" }, userId: "u2" } as any, denied);
    expect(denied.status).toHaveBeenCalledWith(403);
  });

  it("changes a role and 404s for an unknown member", async () => {
    db.room.findFirst.mockResolvedValue({ id: 1, adminId: OWNER });
    db.roomMember.updateMany.mockResolvedValue({ count: 1 });
    const ok = makeRes();
    await call(updateRoomMemberRole, { params: { roomId: "1", userId: "u2" }, body: { role: "VIEWER" }, userId: OWNER } as any, ok);
    expect(db.roomMember.updateMany).toHaveBeenCalledWith({
      where: { roomId: 1, userId: "u2" },
      data: { role: "VIEWER" },
    });
    expect(ok.status).toHaveBeenCalledWith(200);

    db.roomMember.updateMany.mockResolvedValue({ count: 0 });
    const missing = makeRes();
    await call(updateRoomMemberRole, { params: { roomId: "1", userId: "ghost" }, body: { role: "EDITOR" }, userId: OWNER } as any, missing);
    expect(missing.status).toHaveBeenCalledWith(404);
  });

  it("rejects an invalid role", async () => {
    db.room.findFirst.mockResolvedValue({ id: 1, adminId: OWNER });
    const res = makeRes();
    await call(updateRoomMemberRole, { params: { roomId: "1", userId: "u2" }, body: { role: "ADMIN" }, userId: OWNER } as any, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(db.roomMember.updateMany).not.toHaveBeenCalled();
  });

  it("removes a member and their approved access request", async () => {
    db.room.findFirst.mockResolvedValue({ id: 1, adminId: OWNER });
    db.$transaction.mockResolvedValue([]);
    const res = makeRes();
    await call(removeRoomMember, { params: { roomId: "1", userId: "u2" }, userId: OWNER } as any, res);
    expect(db.roomMember.deleteMany).toHaveBeenCalledWith({ where: { roomId: 1, userId: "u2" } });
    expect(db.roomAccessRequest.deleteMany).toHaveBeenCalledWith({ where: { roomId: 1, requesterId: "u2" } });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("approving with role VIEWER creates a viewer membership", async () => {
    db.roomAccessRequest.findUnique.mockResolvedValue({
      id: 9,
      requesterId: "u3",
      status: "PENDING",
      room: { id: 1, adminId: OWNER },
    });
    db.$transaction.mockImplementation(async (fn: any) => fn(db));
    const res = makeRes();
    await call(decideRoomAccessRequest, { body: { requestId: 9, action: "approve", role: "VIEWER" }, userId: OWNER } as any, res);
    expect(db.roomMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { roomId: 1, userId: "u3", role: "VIEWER" },
        update: { role: "VIEWER" },
      }),
    );
  });

  it("blocks viewers from replacing the canvas over REST", async () => {
    db.room.findFirst.mockResolvedValue(null); // neither owner nor EDITOR member
    const res = makeRes();
    await call(replaceShapes, { params: { roomId: "1" }, body: { shapes: [] }, userId: "viewer" } as any, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.room.findFirst.mock.calls[0][0].where.OR[1]).toEqual({
      members: { some: { userId: "viewer", role: "EDITOR" } },
    });
  });
});

describe("version history endpoints", () => {
  it("lists snapshots without payloads for members", async () => {
    db.room.findFirst.mockResolvedValue({ id: 1 });
    db.roomSnapshot.findMany.mockResolvedValue([{ id: 5, shapeCount: 3, createdAt: new Date() }]);
    const res = makeRes();
    await call(listRoomHistory, { params: { roomId: "1" }, userId: "member" } as any, res);
    expect(db.roomSnapshot.findMany.mock.calls[0][0].select).toEqual({ id: true, shapeCount: true, createdAt: true });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("scopes a snapshot lookup to the requested room", async () => {
    db.room.findFirst.mockResolvedValue({ id: 1 });
    db.roomSnapshot.findFirst.mockResolvedValue(null);
    const res = makeRes();
    await call(getRoomHistorySnapshot, { params: { roomId: "1", snapshotId: "77" }, userId: "member" } as any, res);
    expect(db.roomSnapshot.findFirst.mock.calls[0][0].where).toEqual({ id: 77, roomId: 1 });
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("denies history to non-members", async () => {
    db.room.findFirst.mockResolvedValue(null);
    const res = makeRes();
    await call(listRoomHistory, { params: { roomId: "1" }, userId: "stranger" } as any, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(db.roomSnapshot.findMany).not.toHaveBeenCalled();
  });
});

describe("slides", () => {
  const slide = { title: "Intro", x: 0, y: 0, width: 1600, height: 900 };

  it("lists slides in order for members", async () => {
    db.room.findFirst.mockResolvedValue({ id: 1 });
    db.roomSlide.findMany.mockResolvedValue([{ id: 1, ...slide }]);
    const res = makeRes();
    await call(listRoomSlides, { params: { roomId: "1" }, userId: "member" } as any, res);
    expect(db.roomSlide.findMany.mock.calls[0][0].orderBy).toEqual({ position: "asc" });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("replaces the deck with positions assigned by order", async () => {
    db.room.findFirst.mockResolvedValue({ id: 1 });
    db.$transaction.mockResolvedValue([]);
    db.roomSlide.findMany.mockResolvedValue([]);
    const res = makeRes();
    await call(replaceRoomSlides, { params: { roomId: "1" }, body: { slides: [slide, { ...slide, title: "Two" }] }, userId: OWNER } as any, res);
    expect(db.roomSlide.createMany).toHaveBeenCalledWith({
      data: [
        { roomId: 1, position: 0, ...slide },
        { roomId: 1, position: 1, ...slide, title: "Two" },
      ],
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("rejects invalid slides and non-editors", async () => {
    db.room.findFirst.mockResolvedValue({ id: 1 });
    const bad = makeRes();
    await call(replaceRoomSlides, { params: { roomId: "1" }, body: { slides: [{ ...slide, width: 0 }] }, userId: OWNER } as any, bad);
    expect(bad.status).toHaveBeenCalledWith(400);

    db.room.findFirst.mockResolvedValue(null);
    const denied = makeRes();
    await call(replaceRoomSlides, { params: { roomId: "1" }, body: { slides: [slide] }, userId: "viewer" } as any, denied);
    expect(denied.status).toHaveBeenCalledWith(403);
  });
});
