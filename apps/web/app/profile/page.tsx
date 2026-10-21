"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { HTTP_BACKEND } from "../../config";
import { apiClient } from "../lib/apiClient";
import { ensureAuthenticated } from "../lib/auth";
import { useTheme } from "../components/ThemeToggle";

type ProfileData = {
  id: string;
  name: string;
  handle: string | null;
  email: string;
};

export default function ProfilePage() {
  const router = useRouter();
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<"email" | "id" | null>(null);
  const [roomSlug, setRoomSlug] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let isUnmounted = false;

    const loadProfile = async () => {
      const authenticated = await ensureAuthenticated("/profile");
      if (!authenticated || isUnmounted) {
        return;
      }

      try {
        const response = await apiClient.get(
          `${HTTP_BACKEND}/auth/current-user`,
        );
        const user = response.data?.data;

        if (isUnmounted) return;

        if (
          user &&
          typeof user.id === "string" &&
          typeof user.name === "string" &&
          typeof user.email === "string"
        ) {
          setProfile({
            id: user.id,
            name: user.name,
            handle: typeof user.handle === "string" ? user.handle : null,
            email: user.email,
          });
        } else {
          setErrorMessage("Unable to load your profile details.");
        }
      } catch {
        if (!isUnmounted) {
          setErrorMessage("Unable to load your profile details.");
        }
      } finally {
        if (!isUnmounted) {
          setIsLoading(false);
        }
      }
    };

    void loadProfile();

    return () => {
      isUnmounted = true;
    };
  }, []);

  const copyField = async (type: "email" | "id", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(type);
      window.setTimeout(() => {
        setCopiedField((current) => (current === type ? null : current));
      }, 1400);
    } catch {
      // Ignore clipboard failures and keep UI stable.
    }
  };

  const initials = profile?.name
    .split(" ")
    .map((part) => part.trim()[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const shortUserId = profile
    ? `${profile.id.slice(0, 8)}...${profile.id.slice(-6)}`
    : "-";

  const handleJoinRoom = () => {
    const slug = roomSlug.trim().toLowerCase();

    if (slug.length < 3 || slug.length > 50) {
      setActionError("Room slug must be between 3 and 50 characters.");
      return;
    }

    setActionError(null);
    if (!profile?.handle) {
      setActionError(
        "Your account handle is not ready yet. Try again in a moment.",
      );
      return;
    }

    router.push(
      `/room/${encodeURIComponent(profile.handle)}/${encodeURIComponent(slug)}`,
    );
  };

  return (
    <main
      className={`min-h-screen px-5 py-8 sm:px-8 sm:py-10 ${
        isDark ? "bg-[#121212] text-white" : "bg-[#f2f5fa] text-slate-900"
      }`}
    >
      <section className="mx-auto w-full max-w-5xl">
        <div
          className={`overflow-hidden rounded-3xl border ${
            isDark
              ? "border-white/10 bg-[#191919]/95 shadow-[0_18px_30px_rgba(0,0,0,0.45)]"
              : "border-slate-300/90 bg-slate-50/95 shadow-[0_18px_28px_rgba(15,23,42,0.08)]"
          }`}
        >
          <div
            className={`px-6 pb-6 pt-7 sm:px-8 ${
              isDark
                ? "bg-[linear-gradient(120deg,rgba(59,130,246,0.2),rgba(6,182,212,0.12),rgba(15,23,42,0.12))]"
                : "bg-[linear-gradient(120deg,rgba(14,116,144,0.14),rgba(59,130,246,0.12),rgba(244,247,252,0.95))]"
            }`}
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-center gap-4">
                <div
                  className={`grid h-16 w-16 place-items-center rounded-2xl text-lg font-semibold ${
                    isDark
                      ? "bg-white/10 text-white"
                      : "bg-slate-900/90 text-white"
                  }`}
                >
                  {initials || "U"}
                </div>
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight">
                    Profile
                  </h1>
                  <p className="mt-1 text-sm opacity-80">
                    Manage your account details and security settings
                  </p>
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => router.back()}
                  className={`rounded-xl border px-4 py-2 text-sm font-medium transition ${
                    isDark
                      ? "border-white/20 hover:bg-white/10"
                      : "border-slate-300 bg-white/70 hover:bg-white"
                  }`}
                >
                  Go back
                </button>
                <button
                  type="button"
                  onClick={() => router.push("/")}
                  className={`rounded-xl border px-4 py-2 text-sm font-medium transition ${
                    isDark
                      ? "border-rule-strong bg-paper-2 text-ink hover:bg-paper"
                      : "border-rule-strong bg-paper-2 text-ink hover:bg-paper"
                  }`}
                >
                  Home
                </button>
              </div>
            </div>
          </div>

          <div className="grid gap-5 p-6 sm:p-8 md:grid-cols-3">
            <div className="space-y-5 md:col-span-2">
              <div
                className={`rounded-2xl border p-4 ${isDark ? "border-white/10 bg-black/15" : "border-slate-200 bg-white/85"}`}
              >
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-semibold uppercase tracking-wide opacity-75">
                    Account Identity
                  </h2>
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-medium ${isDark ? "bg-emerald-500/20 text-emerald-200" : "bg-emerald-100 text-emerald-800"}`}
                  >
                    Active
                  </span>
                </div>

                {isLoading && (
                  <div className="space-y-3 animate-pulse">
                    <div
                      className={`h-14 rounded-xl ${isDark ? "bg-white/10" : "bg-slate-200"}`}
                    />
                    <div
                      className={`h-16 rounded-xl ${isDark ? "bg-white/10" : "bg-slate-200"}`}
                    />
                    <div
                      className={`h-16 rounded-xl ${isDark ? "bg-white/10" : "bg-slate-200"}`}
                    />
                  </div>
                )}

                {!isLoading && errorMessage && (
                  <p
                    className={`text-sm ${isDark ? "text-red-300" : "text-red-700"}`}
                  >
                    {errorMessage}
                  </p>
                )}

                {!isLoading && profile && (
                  <div className="space-y-3 text-sm">
                    <div className="rounded-xl border border-current/10 px-3 py-2">
                      <div className="opacity-70">Name</div>
                      <div className="font-medium">{profile.name}</div>
                    </div>
                    <div className="rounded-xl border border-current/10 px-3 py-2">
                      <div className="mb-1 opacity-70">Email</div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="font-medium break-all">
                          {profile.email}
                        </div>
                        <button
                          type="button"
                          onClick={() => copyField("email", profile.email)}
                          className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
                            isDark
                              ? "border-white/15 hover:bg-white/10"
                              : "border-slate-300 hover:bg-slate-100"
                          }`}
                        >
                          {copiedField === "email" ? "Copied" : "Copy"}
                        </button>
                      </div>
                    </div>
                    <div className="rounded-xl border border-current/10 px-3 py-2">
                      <div className="mb-1 opacity-70">User ID</div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="font-medium" title={profile.id}>
                          {shortUserId}
                        </div>
                        <button
                          type="button"
                          onClick={() => copyField("id", profile.id)}
                          className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
                            isDark
                              ? "border-white/15 hover:bg-white/10"
                              : "border-slate-300 hover:bg-slate-100"
                          }`}
                        >
                          {copiedField === "id" ? "Copied" : "Copy"}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div
                className={`rounded-2xl border p-4 ${isDark ? "border-white/10 bg-black/15" : "border-slate-200 bg-white/85"}`}
              >
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide opacity-75">
                  Security
                </h2>
                <p className="mb-4 text-sm opacity-80">
                  Keep your account safe by rotating your password regularly.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => router.push("/forgot-password")}
                    className={`rounded-xl border px-4 py-2 text-sm font-medium transition ${
                      isDark
                        ? "border-amber-300/35 bg-amber-500/10 text-amber-100 hover:bg-amber-500/20"
                        : "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"
                    }`}
                  >
                    Reset password
                  </button>
                  <button
                    type="button"
                    onClick={() => router.push("/signin")}
                    className={`rounded-xl border px-4 py-2 text-sm font-medium transition ${
                      isDark
                        ? "border-white/15 hover:bg-white/10"
                        : "border-slate-300 hover:bg-slate-100"
                    }`}
                  >
                    Sign in on another account
                  </button>
                </div>
              </div>
            </div>

            <aside className="space-y-5">
              <div
                className={`rounded-2xl border p-4 ${isDark ? "border-white/10 bg-black/15" : "border-slate-200 bg-white"}`}
              >
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide opacity-75">
                  Quick Actions
                </h2>
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => router.push("/rooms")}
                    className={`w-full rounded-xl border px-3 py-2 text-left text-sm font-medium transition ${
                      isDark
                        ? "border-white/15 hover:bg-white/10"
                        : "border-slate-300 hover:bg-slate-100"
                    }`}
                  >
                    Open room dashboard
                  </button>
                  <div className="space-y-2 rounded-xl border border-current/10 p-2">
                    <label
                      htmlFor="room-slug"
                      className="px-1 text-xs font-medium opacity-75"
                    >
                      Join room by slug
                    </label>
                    <input
                      id="room-slug"
                      type="text"
                      value={roomSlug}
                      onChange={(event) => setRoomSlug(event.target.value)}
                      placeholder="example-room"
                      className={`w-full rounded-lg border px-3 py-2 text-sm outline-none transition ${
                        isDark
                          ? "border-white/15 bg-[#171717] text-white placeholder:text-white/40 focus:border-ink"
                          : "border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 focus:border-ink"
                      }`}
                    />
                    <button
                      type="button"
                      onClick={handleJoinRoom}
                      className={`w-full rounded-lg border px-3 py-2 text-sm font-medium transition ${
                        isDark
                          ? "border-rule-strong bg-paper-2 text-ink hover:bg-paper"
                          : "border-rule-strong bg-paper-2 text-ink hover:bg-paper"
                      }`}
                    >
                      Join room
                    </button>
                  </div>
                  {actionError && (
                    <p
                      className={`px-1 text-xs ${isDark ? "text-red-300" : "text-red-700"}`}
                    >
                      {actionError}
                    </p>
                  )}
                </div>
              </div>

              <div
                className={`rounded-2xl border p-4 ${isDark ? "border-white/10 bg-black/15" : "border-slate-200 bg-white"}`}
              >
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide opacity-75">
                  Session
                </h2>
                <p className="text-sm opacity-80">
                  Signed in and synced with your workspace.
                </p>
              </div>
            </aside>
          </div>
        </div>
      </section>
    </main>
  );
}
