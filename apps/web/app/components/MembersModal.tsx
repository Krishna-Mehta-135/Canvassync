"use client";

import { useEffect, useState } from "react";
import { apiClient } from "../lib/apiClient";
import { HTTP_BACKEND } from "../../config";

type Role = "EDITOR" | "VIEWER";
type Member = { userId: string; name: string; handle: string | null; role: Role };

type MembersModalProps = {
  roomId: number;
  isDark: boolean;
  onClose: () => void;
};

/** Owner-only: see who has access and switch people between editor and view-only. */
export function MembersModal({ roomId, isDark, onClose }: MembersModalProps) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get(`${HTTP_BACKEND}/room/${roomId}/members`)
      .then((response) => {
        if (!cancelled) setMembers((response.data?.data?.members ?? []) as Member[]);
      })
      .catch(() => {
        if (!cancelled) setForbidden(true);
      });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  const changeRole = async (member: Member, role: Role) => {
    setBusyId(member.userId);
    setError(null);
    try {
      await apiClient.patch(
        `${HTTP_BACKEND}/room/${roomId}/members/${encodeURIComponent(member.userId)}`,
        { role },
      );
      setMembers((current) =>
        current?.map((item) => (item.userId === member.userId ? { ...item, role } : item)) ?? null,
      );
    } catch {
      setError("Couldn't change that role.");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (member: Member) => {
    setBusyId(member.userId);
    setError(null);
    try {
      await apiClient.delete(
        `${HTTP_BACKEND}/room/${roomId}/members/${encodeURIComponent(member.userId)}`,
      );
      setMembers((current) => current?.filter((item) => item.userId !== member.userId) ?? null);
    } catch {
      setError("Couldn't remove that person.");
    } finally {
      setBusyId(null);
    }
  };

  const surface = isDark
    ? "border-white/15 bg-[#171717] text-white/90"
    : "border-slate-300 bg-white text-slate-800";
  const select = isDark ? "border-white/15 bg-black/30" : "border-slate-300 bg-slate-50";

  return (
    <div
      className="absolute inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="People and roles"
        className={`max-h-[85vh] w-[min(520px,100%)] overflow-y-auto rounded-2xl border p-5 shadow-2xl ${surface}`}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") onClose();
        }}
      >
        <div className="mb-1 text-base font-semibold">People &amp; roles</div>
        <p className="mb-4 text-xs opacity-70">
          Editors can change the canvas. Viewers can look around, follow, chat and comment — but not
          edit. Changes apply within seconds, even to people already in the room.
        </p>

        {forbidden && <p className="text-sm">Only the room owner can manage people.</p>}
        {!forbidden && members === null && <p className="text-sm opacity-70">Loading…</p>}
        {members && members.length === 0 && (
          <p className="text-sm opacity-70">
            Nobody besides you has access yet. Share the invite link and approve requests to add people.
          </p>
        )}

        <ul className="space-y-2">
          {members?.map((member) => (
            <li
              key={member.userId}
              className="flex items-center gap-3 rounded-xl border border-current/10 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{member.name}</div>
                {member.handle && <div className="truncate text-xs opacity-60">@{member.handle}</div>}
              </div>
              <select
                value={member.role}
                disabled={busyId === member.userId}
                onChange={(event) => void changeRole(member, event.target.value as Role)}
                aria-label={`Role for ${member.name}`}
                className={`rounded-lg border px-2 py-1 text-xs ${select}`}
              >
                <option value="EDITOR">Can edit</option>
                <option value="VIEWER">View only</option>
              </select>
              <button
                type="button"
                disabled={busyId === member.userId}
                onClick={() => void remove(member)}
                className="rounded-lg px-2 py-1 text-xs text-red-500 hover:bg-red-500/10 disabled:opacity-40"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>

        {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs opacity-80 hover:opacity-100">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
