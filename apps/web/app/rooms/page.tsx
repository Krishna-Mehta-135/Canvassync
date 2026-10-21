"use client";

/* File intent: Workspace hub for browsing, creating, and managing canvases. */

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AxiosError } from "axios";
import { HTTP_BACKEND } from "../../config";
import { apiClient } from "../lib/apiClient";
import { ensureAuthenticated, logoutUser } from "../lib/auth";
import { useTheme } from "../components/ThemeToggle";
import { RoomThumbnail } from "../components/RoomThumbnail";
import { CanvasLogo } from "../components/CanvasLogo";

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
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(isoDate));
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
  const { theme, toggleTheme } = useTheme();

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

  const textBtn =
    "text-[13.5px] text-ink-2 underline decoration-rule-strong underline-offset-[5px] transition hover:text-ink hover:decoration-ink disabled:opacity-50";

  return (
    <main className="min-h-screen bg-paper text-ink" style={{ fontFamily: "var(--font-ui)" }}>
      <header className="border-b border-rule">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
          <Link href="/" className="flex items-center gap-2.5">
            <CanvasLogo className="h-6 w-6" />
            <span className="font-display text-[24px] leading-none">Canvas</span>
          </Link>
          <div className="flex items-center gap-5">
            {user && (
              <span className="hidden font-mono text-[11.5px] text-ink-3 sm:block">
                {user.handle ? `@${user.handle}` : user.email}
              </span>
            )}
            <button type="button" onClick={() => router.push("/profile")} className={textBtn}>
              Profile
            </button>
            <button type="button" onClick={() => void handleLogout()} disabled={isLoggingOut} className={textBtn}>
              {isLoggingOut ? "Signing out…" : "Sign out"}
            </button>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label="Toggle theme"
              className="grid h-8 w-8 place-items-center rounded-[6px] text-ink-3 transition hover:bg-paper-2 hover:text-ink"
            >
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                {theme === "dark" ? (
                  <>
                    <circle cx="10" cy="10" r="3.4" />
                    <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
                  </>
                ) : (
                  <path d="M16 11.5A6.5 6.5 0 018.5 4a6.5 6.5 0 107.5 7.5z" />
                )}
              </svg>
            </button>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-5 pb-24 pt-12 sm:px-8">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <h1 className="font-display text-[clamp(2.4rem,6vw,4rem)] leading-none tracking-tight">Your canvases</h1>
            {!loading && (
              <p className="mt-3 font-mono text-[12px] text-ink-3">
                {sortedRooms.length} {sortedRooms.length === 1 ? "canvas" : "canvases"}
              </p>
            )}
          </div>
          <form onSubmit={handleCreateRoom} className="flex w-full max-w-md gap-2">
            <input
              value={newRoomSlug}
              onChange={(event) => setNewRoomSlug(event.target.value)}
              placeholder="name-for-a-new-canvas"
              aria-label="New canvas name"
              className="min-w-0 flex-1 rounded-[7px] border border-rule-strong bg-surface px-3.5 py-2.5 font-mono text-[13px] text-ink outline-none transition placeholder:text-ink-3 focus:border-ink"
            />
            <button
              type="submit"
              disabled={creatingRoom}
              className="shrink-0 rounded-[7px] bg-ink px-4 py-2.5 text-[13.5px] font-medium text-paper shadow-[3px_3px_0_var(--signal)] transition active:translate-x-px active:translate-y-px active:shadow-[2px_2px_0_var(--signal)] disabled:opacity-60"
            >
              {creatingRoom ? "Creating…" : "New canvas"}
            </button>
          </form>
        </div>

        {error && (
          <p role="alert" className="mt-6 rounded-[6px] border border-signal/40 bg-signal-soft px-4 py-3 text-[13.5px] text-signal">
            {error}
          </p>
        )}

        {incomingRequests.length > 0 && (
          <div className="mt-10 border border-rule-strong bg-surface">
            <p className="border-b border-rule px-4 py-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-3">
              People asking to join · {incomingRequests.length}
            </p>
            <ul>
              {incomingRequests.map((request) => (
                <li key={request.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-4 py-3 last:border-0">
                  <p className="min-w-0 text-[14px]">
                    <b className="font-semibold">{request.requester.name}</b>
                    <span className="text-ink-2"> wants into </span>
                    <span className="font-mono text-[12.5px] text-signal">/{request.room.slug}</span>
                  </p>
                  <div className="flex gap-4">
                    <button type="button" disabled={requestActionInFlightId === request.id} onClick={() => void handleRequestDecision(request.id, "approve")} className={textBtn}>
                      Let in
                    </button>
                    <button
                      type="button"
                      disabled={requestActionInFlightId === request.id}
                      onClick={() => void handleRequestDecision(request.id, "approve", "VIEWER")}
                      title="Can look, follow and chat, but not edit"
                      className={textBtn}
                    >
                      View only
                    </button>
                    <button type="button" disabled={requestActionInFlightId === request.id} onClick={() => void handleRequestDecision(request.id, "reject")} className={`${textBtn} !text-signal`}>
                      Decline
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {loading ? (
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="aspect-[4/3] animate-pulse border border-rule bg-paper-2" />
            ))}
          </div>
        ) : sortedRooms.length === 0 ? (
          <div className="mt-16 border border-dashed border-rule-strong px-6 py-20 text-center">
            <p className="font-display text-[40px] italic leading-none text-ink-2">Nothing here yet.</p>
            <p className="mt-3 text-[14px] text-ink-3">Name a canvas above to start drawing.</p>
          </div>
        ) : (
          <div className="mt-12 grid gap-x-6 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
            {sortedRooms.map((room) => {
              const isEditing = renamingRoomId === room.id;
              return (
                <article key={room.id} className="group border border-rule-strong bg-surface transition-colors hover:border-ink">
                  <a href={room.canonicalPath} className="block" aria-label={`Open ${room.slug}`}>
                    <RoomThumbnail roomId={room.id} />
                  </a>
                  <div className="flex items-start justify-between gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      {isEditing ? (
                        <div className="flex gap-2">
                          <input
                            value={renameDraft}
                            onChange={(event) => setRenameDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") void handleSaveRename(room.id);
                              if (event.key === "Escape") handleCancelRename();
                            }}
                            autoFocus
                            aria-label="Canvas name"
                            className="min-w-0 flex-1 rounded-[5px] border border-ink bg-paper px-2 py-1 font-mono text-[13px] outline-none"
                          />
                          <button type="button" onClick={() => void handleSaveRename(room.id)} disabled={savingRename} className="rounded-[5px] bg-ink px-2.5 text-[12px] font-medium text-paper">
                            Save
                          </button>
                        </div>
                      ) : (
                        <a href={room.canonicalPath} className="block">
                          <h3 className="truncate font-display text-[24px] leading-tight">{room.slug}</h3>
                          <p className="mt-0.5 font-mono text-[10.5px] text-ink-3">Created {formatDate(room.createdAt)}</p>
                        </a>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => (isEditing ? handleCancelRename() : handleStartRename(room))}
                      title={isEditing ? "Cancel" : "Rename"}
                      aria-label={isEditing ? "Cancel rename" : `Rename ${room.slug}`}
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-[5px] text-ink-3 opacity-0 transition hover:bg-paper-2 hover:text-ink focus:opacity-100 group-hover:opacity-100"
                    >
                      <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        {isEditing ? <path d="M5 5l10 10M15 5L5 15" /> : <path d="M12.5 4.5l3 3L7 16H4v-3z" />}
                      </svg>
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
