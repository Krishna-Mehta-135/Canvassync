"use client";

/* File intent: Workspace hub for browsing, creating, and managing canvases. */

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AxiosError } from "axios";
import { HTTP_BACKEND } from "../../config";
import { apiClient } from "../lib/apiClient";
import { ensureAuthenticated, logoutUser } from "../lib/auth";
import { useTheme } from "../components/ThemeToggle";

type CurrentUser = {
  id: string;
  name: string;
  handle: string | null;
  email: string;
};

type Room = {
  id: number;
  slug: string;
  createdAt: string;
  canonicalPath: string;
};

type IncomingAccessRequest = {
  id: number;
  createdAt: string;
  requester: {
    id: string;
    name: string;
    handle: string | null;
    email: string;
  };
  room: {
    id: number;
    slug: string;
  };
};

type RawRoom = Partial<Room> & {
  id?: number;
  slug?: string;
  createdAt?: string;
  canonicalPath?: string;
};

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function formatDate(isoDate: string): string {
  try {
    return new Date(isoDate).toLocaleString();
  } catch {
    return isoDate;
  }
}

function normalizeRoom(room: RawRoom, handle: string | null): Room | null {
  if (typeof room.id !== "number" || typeof room.slug !== "string") {
    return null;
  }

  const fallbackCanonicalPath =
    handle && handle.length > 0
      ? `/room/${encodeURIComponent(handle)}/${encodeURIComponent(room.slug)}`
      : `/canvas/${encodeURIComponent(room.slug)}`;

  return {
    id: room.id,
    slug: room.slug,
    createdAt:
      typeof room.createdAt === "string"
        ? room.createdAt
        : new Date().toISOString(),
    canonicalPath:
      typeof room.canonicalPath === "string" && room.canonicalPath.length > 0
        ? room.canonicalPath
        : fallbackCanonicalPath,
  };
}

export default function RoomsPage() {
  const router = useRouter();
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const [user, setUser] = useState<CurrentUser | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newRoomSlug, setNewRoomSlug] = useState("");
  const [creatingRoom, setCreatingRoom] = useState(false);

  const [renamingRoomId, setRenamingRoomId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [savingRename, setSavingRename] = useState(false);

  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [incomingRequests, setIncomingRequests] = useState<
    IncomingAccessRequest[]
  >([]);
  const [requestActionInFlightId, setRequestActionInFlightId] = useState<
    number | null
  >(null);

  const sortedRooms = useMemo(() => {
    return [...rooms].sort((a, b) => {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [rooms]);

  const loadData = async () => {
    setLoading(true);
    setError(null);

    try {
      const isAuthenticated = await ensureAuthenticated("/rooms");
      if (!isAuthenticated) return;

      const userResponse = await apiClient.get(
        `${HTTP_BACKEND}/auth/current-user`,
      );
      const currentUser = userResponse.data?.data as CurrentUser;
      setUser(currentUser);

      try {
        const roomsResponse = await apiClient.get(`${HTTP_BACKEND}/room/mine`);
        const roomList = (roomsResponse.data?.data ?? []) as RawRoom[];

        const normalizedRooms = Array.isArray(roomList)
          ? roomList
              .map((room) => normalizeRoom(room, currentUser.handle))
              .filter((room): room is Room => room !== null)
          : [];

        setRooms(normalizedRooms);

        const requestResponse = await apiClient.get(
          `${HTTP_BACKEND}/room/access/requests/incoming`,
        );
        const requestList = requestResponse.data?.data;
        setIncomingRequests(
          Array.isArray(requestList)
            ? (requestList as IncomingAccessRequest[])
            : [],
        );
      } catch {
        setRooms([]);
        setError("Unable to load your rooms right now.");
      }
    } catch {
      setError("Unable to load your account right now.");
    } finally {
      setLoading(false);
    }
  };

  const handleRequestDecision = async (
    requestId: number,
    action: "approve" | "reject",
    role?: "EDITOR" | "VIEWER",
  ) => {
    setRequestActionInFlightId(requestId);
    setError(null);

    try {
      await apiClient.post(`${HTTP_BACKEND}/room/access/requests/decision`, {
        requestId,
        action,
        ...(role ? { role } : {}),
      });

      setIncomingRequests((current) =>
        current.filter((request) => request.id !== requestId),
      );
    } catch (errorResponse) {
      const axiosError = errorResponse as AxiosError<{ message?: string }>;
      setError(
        axiosError.response?.data?.message ?? `Unable to ${action} request.`,
      );
    } finally {
      setRequestActionInFlightId(null);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleCreateRoom = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const slug = slugify(newRoomSlug);

    if (slug.length < 3) {
      setError("Room slug must be at least 3 characters.");
      return;
    }

    setCreatingRoom(true);
    setError(null);

    try {
      const response = await apiClient.post(`${HTTP_BACKEND}/room`, { slug });
      const rawRoom = response.data?.data as RawRoom;
      const room = normalizeRoom(rawRoom, user?.handle ?? null);

      if (!room) {
        throw new Error("Invalid room payload");
      }

      setRooms((current) => [
        room,
        ...current.filter((entry) => entry.id !== room.id),
      ]);
      setNewRoomSlug("");
      window.location.href = room.canonicalPath;
    } catch (errorResponse) {
      const axiosError = errorResponse as AxiosError<{ message?: string }>;
      setError(axiosError.response?.data?.message ?? "Unable to create room.");
    } finally {
      setCreatingRoom(false);
    }
  };

  const handleStartRename = (room: Room) => {
    setRenamingRoomId(room.id);
    setRenameDraft(room.slug);
  };

  const handleCancelRename = () => {
    setRenamingRoomId(null);
    setRenameDraft("");
  };

  const handleSaveRename = async (roomId: number) => {
    const slug = slugify(renameDraft);
    if (slug.length < 3) {
      setError("Room slug must be at least 3 characters.");
      return;
    }

    setSavingRename(true);
    setError(null);

    try {
      const response = await apiClient.patch(
        `${HTTP_BACKEND}/room/${roomId}/slug`,
        { slug },
      );
      const updatedRoom = response.data?.data as Room;

      setRooms((current) =>
        current.map((room) => {
          if (room.id !== roomId) return room;
          return {
            ...room,
            slug: updatedRoom.slug,
            canonicalPath: updatedRoom.canonicalPath,
          };
        }),
      );

      setRenamingRoomId(null);
      setRenameDraft("");
    } catch (errorResponse) {
      const axiosError = errorResponse as AxiosError<{ message?: string }>;
      setError(axiosError.response?.data?.message ?? "Unable to rename room.");
    } finally {
      setSavingRename(false);
    }
  };

  const handleLogout = async () => {
    if (isLoggingOut) return;

    setIsLoggingOut(true);
    try {
      await logoutUser();
    } finally {
      window.location.href = "/";
    }
  };

  return (
    <main
      className={`min-h-screen overflow-y-auto px-5 py-8 text-slate-900 transition-colors duration-300 sm:px-8 sm:py-12 ${isDark ? "bg-[radial-gradient(circle_at_18%_12%,rgba(59,130,246,0.20),transparent_30%),radial-gradient(circle_at_82%_10%,rgba(139,92,246,0.16),transparent_24%),linear-gradient(180deg,#0f172a_0%,#020617_70%,#020617_100%)] text-white" : "bg-[radial-gradient(circle_at_20%_15%,rgba(59,130,246,0.22),transparent_40%),radial-gradient(circle_at_80%_12%,rgba(16,185,129,0.18),transparent_35%),radial-gradient(circle_at_50%_50%,rgba(99,102,241,0.12),transparent_60%),linear-gradient(180deg,#edf4ff_0%,#ffffff_45%,#f0f7ff_100%)]"}`}
    >
      <section className="relative mx-auto w-full max-w-6xl">
        <div
          className={`rounded-[36px] border p-6 shadow-[0_30px_120px_rgba(15,23,42,0.12)] backdrop-blur-2xl sm:p-10 ${isDark ? "border-white/10 bg-[#111111]/95 shadow-black/30" : "border-slate-200/70 bg-white/88 shadow-slate-200/50"}`}
        >
          <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
            <div>
              <p
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.25em] ${isDark ? "border-white/10 bg-white/5 text-blue-200" : "border-slate-200 bg-white text-blue-700"}`}
              >
                Workspace hub
              </p>
              <h1 className="mt-4 text-3xl font-black tracking-tight text-slate-900 dark:text-white sm:text-4xl">
                Your Canvases
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 opacity-70">
                Manage your creative workspaces and collaborations from a single
                polished view.
              </p>
              {user && (
                <p className="mt-4 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-medium opacity-80 shadow-sm transition hover:opacity-100 dark:border-white/10 dark:bg-white/5 dark:text-blue-200 border-slate-200 bg-slate-50 text-blue-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse"></span>
                  {user.name} ({user.handle ?? user.email})
                </p>
              )}
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => router.push("/profile")}
                className={`rounded-2xl border px-5 py-2.5 text-sm font-semibold transition-all hover:scale-[1.02] active:scale-[0.98] ${isDark ? "border-white/20 bg-white/5 hover:bg-white/10" : "border-slate-200 bg-white shadow-sm hover:border-slate-300 hover:bg-slate-50"}`}
              >
                Profile
              </button>
              <button
                type="button"
                onClick={() => void handleLogout()}
                disabled={isLoggingOut}
                className={`rounded-2xl border px-5 py-2.5 text-sm font-semibold transition-all hover:scale-[1.02] active:scale-[0.98] ${isDark ? "border-red-500/30 bg-red-500/10 text-red-100 hover:bg-red-500/20" : "border-red-200 bg-red-50 text-red-700 hover:bg-red-100"}`}
              >
                {isLoggingOut ? "Signing out..." : "Sign out"}
              </button>
            </div>
          </div>

          <form
            onSubmit={handleCreateRoom}
            className="mb-10 grid gap-3 sm:grid-cols-[1fr_auto]"
          >
            <input
              value={newRoomSlug}
              onChange={(event) => setNewRoomSlug(event.target.value)}
              placeholder="Enter a new canvas slug..."
              className={`w-full rounded-2xl border px-5 py-3.5 text-sm outline-none transition-all ${isDark ? "border-white/10 bg-[#171717] text-white placeholder:text-white/30 focus:border-blue-500/50 focus:ring-4 focus:ring-blue-500/10" : "border-slate-200 bg-white/90 text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-blue-400 focus:ring-4 focus:ring-blue-400/10"}`}
            />
            <button
              type="submit"
              disabled={creatingRoom}
              className={`rounded-2xl border px-6 py-3.5 text-sm font-bold transition-all hover:scale-[1.02] active:scale-[0.98] ${isDark ? "border-blue-500/50 bg-blue-600 text-white hover:bg-blue-500" : "border-blue-500 bg-linear-to-r from-blue-600 via-indigo-600 to-cyan-500 text-white shadow-lg shadow-blue-200/50 hover:from-blue-700 hover:to-indigo-700"}`}
            >
              {creatingRoom ? "Creating..." : "Create new canvas"}
            </button>
          </form>

          {error && (
            <p
              className={`mb-6 rounded-2xl border px-4 py-3 text-sm font-medium ${isDark ? "border-red-500/30 bg-red-500/10 text-red-300" : "border-red-200 bg-red-50 text-red-700"}`}
            >
              {error}
            </p>
          )}

          <div
            className={`mb-10 rounded-3xl border p-5 ${isDark ? "border-white/10 bg-black/20" : "border-slate-100 bg-white/70 shadow-[0_12px_40px_rgba(15,23,42,0.04)]"}`}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500">
                Incoming access requests
              </h2>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${incomingRequests.length > 0 ? "bg-red-500 text-white" : "bg-slate-200 text-slate-600 dark:bg-white/10 dark:text-white/60"}`}
              >
                {incomingRequests.length}
              </span>
            </div>
            {incomingRequests.length === 0 ? (
              <p className="text-xs italic opacity-60">
                No pending requests at the moment.
              </p>
            ) : (
              <div className="space-y-3">
                {incomingRequests.map((request) => (
                  <div
                    key={request.id}
                    className={`flex items-center justify-between rounded-2xl border p-4 shadow-sm ${isDark ? "border-white/5 bg-white/5" : "border-white bg-white"}`}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-bold truncate">
                        {request.requester.name}
                      </p>
                      <p className="text-[11px] opacity-60 truncate">
                        requested access to{" "}
                        <span className="font-semibold text-blue-500">
                          /{request.room.slug}
                        </span>
                      </p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button
                        type="button"
                        disabled={requestActionInFlightId === request.id}
                        onClick={() =>
                          void handleRequestDecision(request.id, "approve")
                        }
                        className={`rounded-lg px-3 py-1.5 text-xs font-bold transition hover:scale-105 active:scale-95 ${isDark ? "bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30" : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"}`}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={requestActionInFlightId === request.id}
                        onClick={() =>
                          void handleRequestDecision(request.id, "approve", "VIEWER")
                        }
                        title="Can look, follow and chat — but not edit"
                        className={`rounded-lg px-3 py-1.5 text-xs font-bold transition hover:scale-105 active:scale-95 ${isDark ? "bg-sky-500/20 text-sky-300 hover:bg-sky-500/30" : "bg-sky-50 text-sky-700 hover:bg-sky-100"}`}
                      >
                        View only
                      </button>
                      <button
                        type="button"
                        disabled={requestActionInFlightId === request.id}
                        onClick={() =>
                          void handleRequestDecision(request.id, "reject")
                        }
                        className={`rounded-lg px-3 py-1.5 text-xs font-bold transition hover:scale-105 active:scale-95 ${isDark ? "bg-red-500/20 text-red-300 hover:bg-red-500/30" : "bg-red-50 text-red-700 hover:bg-red-100"}`}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1 mb-4">
            <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500">
              Your Canvases
            </h2>
          </div>

          {loading ? (
            <div className="flex flex-col items-center justify-center py-20 opacity-40">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-current border-t-transparent" />
              <p className="mt-4 text-sm font-medium">
                Loading your workspaces...
              </p>
            </div>
          ) : sortedRooms.length === 0 ? (
            <div
              className={`rounded-[28px] border border-dashed p-16 text-center ${isDark ? "border-white/10" : "border-slate-200"}`}
            >
              <p className="text-sm font-medium opacity-60">
                No canvases yet. Create your first one above!
              </p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {sortedRooms.map((room) => {
                const isEditing = renamingRoomId === room.id;

                return (
                  <div
                    key={room.id}
                    className={`group flex flex-col rounded-[28px] border p-5 transition-all hover:shadow-xl ${isDark ? "border-white/5 bg-white/5 hover:border-white/20" : "border-slate-100 bg-white/95 hover:border-blue-200 hover:shadow-blue-500/5"}`}
                  >
                    <div className="mb-4 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate text-lg font-bold">
                          /{room.slug}
                        </h3>
                        <p className="text-[11px] font-medium opacity-50 uppercase tracking-tighter">
                          Created {formatDate(room.createdAt).split(",")[0]}
                        </p>
                      </div>
                      <div className="flex gap-1.5">
                        {!isEditing ? (
                          <button
                            type="button"
                            onClick={() => handleStartRename(room)}
                            className={`rounded-lg p-2 transition hover:bg-slate-100 dark:hover:bg-white/10`}
                            title="Rename"
                          >
                            <svg
                              viewBox="0 0 24 24"
                              className="h-4 w-4 opacity-60"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                            >
                              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                              <path d="M18.5 2.5a2.121 2.121 0 113 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={handleCancelRename}
                            className={`rounded-lg p-2 transition hover:bg-slate-100 dark:hover:bg-white/10`}
                            title="Cancel"
                          >
                            <svg
                              viewBox="0 0 24 24"
                              className="h-4 w-4 opacity-60"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                            >
                              <path d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        )}
                      </div>
                    </div>

                    {isEditing ? (
                      <div className="mb-4 flex gap-2">
                        <input
                          value={renameDraft}
                          onChange={(event) =>
                            setRenameDraft(event.target.value)
                          }
                          autoFocus
                          className={`w-full rounded-xl border px-3 py-2 text-sm outline-none transition ${isDark ? "border-white/20 bg-black/40" : "border-slate-200 bg-slate-50 focus:border-blue-400"}`}
                        />
                        <button
                          type="button"
                          onClick={() => void handleSaveRename(room.id)}
                          disabled={savingRename}
                          className="rounded-xl bg-blue-600 px-3 text-xs font-bold text-white hover:bg-blue-500"
                        >
                          Save
                        </button>
                      </div>
                    ) : (
                      <div className="mb-6 h-4" />
                    )}

                    <div className="mt-auto flex items-center justify-between">
                      <a
                        href={room.canonicalPath}
                        className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-xs font-bold transition-all hover:scale-105 active:scale-95 ${isDark ? "border-blue-500/50 bg-blue-600/10 text-blue-400 hover:bg-blue-600/20" : "border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"}`}
                      >
                        Open Workspace
                        <svg
                          viewBox="0 0 24 24"
                          className="h-3 w-3"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                        >
                          <path d="M5 12h14M12 5l7 7-7 7" />
                        </svg>
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
