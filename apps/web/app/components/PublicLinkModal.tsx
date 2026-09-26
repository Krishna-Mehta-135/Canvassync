"use client";

import { useEffect, useState } from "react";
import { apiClient } from "../lib/apiClient";
import { HTTP_BACKEND } from "../../config";

type PublicLinkModalProps = {
  roomId: number;
  isDark: boolean;
  onClose: () => void;
  onCopied: () => void;
};

type LinkState =
  | { phase: "loading" }
  | { phase: "forbidden" }
  | { phase: "ready"; token: string | null };

export function PublicLinkModal({ roomId, isDark, onClose, onCopied }: PublicLinkModalProps) {
  const [state, setState] = useState<LinkState>({ phase: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get(`${HTTP_BACKEND}/room/${roomId}/public`)
      .then((response) => {
        if (!cancelled) {
          setState({ phase: "ready", token: response.data?.data?.token ?? null });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ phase: "forbidden" });
      });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  const token = state.phase === "ready" ? state.token : null;
  const link =
    token && typeof window !== "undefined" ? `${window.location.origin}/view/${token}` : "";

  const run = async (action: () => Promise<{ data?: { data?: { token?: string | null } } }>) => {
    setBusy(true);
    setError(null);
    try {
      const response = await action();
      setState({ phase: "ready", token: response.data?.data?.token ?? null });
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const surface = isDark
    ? "border-white/15 bg-[#171717] text-white/90"
    : "border-slate-300 bg-white text-slate-800";
  const field = isDark ? "border-white/15 bg-black/30" : "border-slate-300 bg-slate-50";
  const secondary = "rounded-lg border border-current/20 px-3 py-1.5 text-xs disabled:opacity-40";

  return (
    <div
      className="absolute inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Public view link"
        className={`w-[min(520px,100%)] rounded-2xl border p-5 shadow-2xl ${surface}`}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") onClose();
        }}
      >
        <div className="mb-1 text-base font-semibold">Public view link</div>
        <p className="mb-4 text-xs opacity-70">
          Anyone with the link can look at this board — read-only, no sign-in. They can&apos;t edit,
          chat or see who&apos;s online. The view refreshes every few seconds.
        </p>

        {state.phase === "loading" && <p className="text-sm opacity-70">Loading…</p>}
        {state.phase === "forbidden" && (
          <p className="text-sm">Only the room owner can manage the public link.</p>
        )}

        {state.phase === "ready" && !token && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => apiClient.post(`${HTTP_BACKEND}/room/${roomId}/public`, {}))}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            Create public link
          </button>
        )}

        {state.phase === "ready" && token && (
          <>
            <input
              readOnly
              value={link}
              onFocus={(event) => event.currentTarget.select()}
              className={`w-full rounded-xl border px-3 py-2 font-mono text-xs outline-none ${field}`}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(link);
                    onCopied();
                  } catch {
                    setError("Copy failed — select the link and copy it manually.");
                  }
                }}
                className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white"
              >
                Copy link
              </button>
              <a href={link} target="_blank" rel="noreferrer" className={secondary}>
                Open
              </a>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(() => apiClient.post(`${HTTP_BACKEND}/room/${roomId}/public`, { rotate: true }))
                }
                className={secondary}
                title="Invalidates the old link and creates a new one"
              >
                New link
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => apiClient.delete(`${HTTP_BACKEND}/room/${roomId}/public`))}
                className={`${secondary} text-red-500`}
              >
                Turn off
              </button>
            </div>
          </>
        )}

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
