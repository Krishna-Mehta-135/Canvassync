"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EphemeralEvent, RoomPresenceState } from "@repo/common";
import type { EphemeralBroadcast } from "../../hooks/useCanvasSync";
import { getPresenceColor } from "./RemotePresenceLayer";
import { useVoiceChat } from "../../hooks/useVoiceChat";

type Viewport = { x: number; y: number; scale: number };

type LiveCollabLayerProps = {
  presenceState: RoomPresenceState;
  currentUserId: string | null;
  viewportRef: React.RefObject<Viewport | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  sendEphemeral: (event: EphemeralEvent) => boolean;
  subscribeEphemeral: (
    listener: (message: EphemeralBroadcast) => void,
  ) => () => void;
  /** Applies a viewport to the canvas (used by follow / presenter mode). */
  applyViewport: (viewport: Viewport) => void;
  /** View-only members can watch the timer but not start or stop it. */
  canControlTimer?: boolean;
  isDark: boolean;
};

type RemoteCursor = {
  name: string;
  /** Target position in canvas space. */
  wx: number;
  wy: number;
  /** Eased position currently drawn, in canvas space. */
  dx: number;
  dy: number;
  text: string | null;
  lastMoveAt: number;
  lastTextAt: number;
};

type FloatingReaction = {
  id: number;
  emoji: string;
  name: string;
  left: number;
  top: number;
};

const REACTIONS = ["👍", "❤️", "🎉", "😂", "🔥", "👀"];
const TIMER_PRESETS_MIN = [1, 3, 5, 10];
const TIMES_UP_VISIBLE_MS = 5000;

type SharedTimer = { deadline: number; label?: string; by: string };

function formatClock(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** Three short beeps; silently does nothing if audio isn't available/allowed. */
function playTimerChime() {
  try {
    const AudioContextClass =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const audio = new AudioContextClass();
    [0, 0.32, 0.64].forEach((offset) => {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, audio.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.2, audio.currentTime + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + offset + 0.25);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(audio.currentTime + offset);
      oscillator.stop(audio.currentTime + offset + 0.3);
    });
    window.setTimeout(() => void audio.close(), 1500);
  } catch {
    // Autoplay policies can block audio until the user interacts; that's fine.
  }
}
const CURSOR_SEND_INTERVAL_MS = 50;
const VIEWPORT_POLL_MS = 120;
const CURSOR_IDLE_HIDE_MS = 5000;
const CURSOR_TEXT_HIDE_MS = 6000;
const LOCAL_TEXT_LINGER_MS = 4000;
const REACTION_LIFETIME_MS = 2000;

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
}

/**
 * Live collaboration overlay: remote cursors, cursor chat ("/"), emoji
 * reactions, and follow / presenter mode.
 *
 * Cursor positions are eased inside a RAF loop with direct DOM writes, so
 * high-frequency network updates never trigger React renders.
 */
export function LiveCollabLayer({
  presenceState,
  currentUserId,
  viewportRef,
  canvasRef,
  sendEphemeral,
  subscribeEphemeral,
  applyViewport,
  canControlTimer = true,
  isDark,
}: LiveCollabLayerProps) {
  const cursorsRef = useRef<Map<string, RemoteCursor>>(new Map());
  const cursorElemsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const bubbleElemsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const [cursorIds, setCursorIds] = useState<string[]>([]);

  const [reactions, setReactions] = useState<FloatingReaction[]>([]);
  const reactionIdRef = useRef(0);

  const lastLocalScreenRef = useRef<{ x: number; y: number } | null>(null);
  const lastCursorSentAtRef = useRef(0);

  const [chatOpen, setChatOpen] = useState(false);
  const [chatText, setChatText] = useState("");
  const [chatPos, setChatPos] = useState({ x: 0, y: 0 });
  const chatInputRef = useRef<HTMLInputElement | null>(null);
  const chatLingerTimerRef = useRef<number | null>(null);

  const voice = useVoiceChat({ currentUserId, sendEphemeral, subscribeEphemeral });

  const [timer, setTimer] = useState<SharedTimer | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [timerMenuOpen, setTimerMenuOpen] = useState(false);
  const [timesUpUntil, setTimesUpUntil] = useState(0);
  const timerFiredRef = useRef(false);

  const [followId, setFollowId] = useState<string | null>(null);
  const followIdRef = useRef<string | null>(null);
  const autoFollowedRef = useRef(false);
  const dismissedPresenterRef = useRef<string | null>(null);
  const [presenting, setPresenting] = useState(false);
  const presentingRef = useRef(false);

  const setFollow = useCallback((id: string | null, auto = false) => {
    followIdRef.current = id;
    autoFollowedRef.current = id !== null && auto;
    setFollowId(id);
  }, []);

  /** Leaves follow mode; an auto-followed presenter isn't re-followed until they restart. */
  const breakFollow = useCallback(() => {
    if (followIdRef.current === null) return;
    if (autoFollowedRef.current) {
      dismissedPresenterRef.current = followIdRef.current;
    }
    setFollow(null);
  }, [setFollow]);

  const namesById = useMemo(() => {
    const map = new Map<string, string>();
    for (const presence of presenceState.presences) {
      map.set(presence.userId, presence.userName);
    }
    return map;
  }, [presenceState.presences]);

  const remoteUsers = useMemo(
    () =>
      presenceState.presences.filter(
        (presence) => presence.userId !== currentUserId,
      ),
    [presenceState.presences, currentUserId],
  );

  const toWorld = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      const viewport = viewportRef.current;
      if (!canvas || !viewport) return null;
      const rect = canvas.getBoundingClientRect();
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;
      return {
        sx,
        sy,
        wx: (sx - viewport.x) / viewport.scale,
        wy: (sy - viewport.y) / viewport.scale,
      };
    },
    [canvasRef, viewportRef],
  );

  // ── Incoming events ────────────────────────────────────────────────────
  useEffect(() => {
    return subscribeEphemeral((message) => {
      const { senderId, senderName, event } = message;
      const now = Date.now();

      if (event.kind === "cursor" || event.kind === "cursor_chat") {
        let cursor = cursorsRef.current.get(senderId);
        const isNew = !cursor;
        if (!cursor) {
          cursor = {
            name: senderName,
            wx: 0,
            wy: 0,
            dx: 0,
            dy: 0,
            text: null,
            lastMoveAt: 0,
            lastTextAt: 0,
          };
          cursorsRef.current.set(senderId, cursor);
        }
        cursor.name = senderName;

        if (event.kind === "cursor") {
          // Snap on first sight so the cursor doesn't fly in from (0,0).
          if (isNew || now - cursor.lastMoveAt > CURSOR_IDLE_HIDE_MS) {
            cursor.dx = event.x;
            cursor.dy = event.y;
          }
          cursor.wx = event.x;
          cursor.wy = event.y;
          cursor.lastMoveAt = now;
        } else {
          cursor.text = event.text && event.text.length > 0 ? event.text : null;
          cursor.lastTextAt = now;
        }

        if (isNew) {
          setCursorIds(Array.from(cursorsRef.current.keys()));
        }
        return;
      }

      if (event.kind === "reaction") {
        const viewport = viewportRef.current;
        if (!viewport) return;
        const id = (reactionIdRef.current += 1);
        setReactions((previous) => [
          ...previous.slice(-30),
          {
            id,
            emoji: event.emoji,
            name: senderName,
            left: event.x * viewport.scale + viewport.x,
            top: event.y * viewport.scale + viewport.y,
          },
        ]);
        window.setTimeout(() => {
          setReactions((previous) => previous.filter((r) => r.id !== id));
        }, REACTION_LIFETIME_MS);
        return;
      }

      if (event.kind === "timer") {
        timerFiredRef.current = false;
        setTimer(
          event.remainingMs === null
            ? null
            : { deadline: Date.now() + event.remainingMs, label: event.label, by: senderName },
        );
        setTimesUpUntil(0);
        return;
      }

      // Voice presence and WebRTC signaling are handled by useVoiceChat.
      if (event.kind === "voice" || event.kind === "rtc") return;

      // Viewport (follow / presenter mode).
      if (event.present === false) {
        if (dismissedPresenterRef.current === senderId) {
          dismissedPresenterRef.current = null;
        }
        if (followIdRef.current === senderId && autoFollowedRef.current) {
          setFollow(null);
        }
        return;
      }

      if (
        event.present === true &&
        followIdRef.current !== senderId &&
        dismissedPresenterRef.current !== senderId
      ) {
        setFollow(senderId, true);
      }

      if (followIdRef.current === senderId) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        applyViewport({
          scale: event.scale,
          x: canvas.clientWidth / 2 - event.x * event.scale,
          y: canvas.clientHeight / 2 - event.y * event.scale,
        });
      }
    });
  }, [subscribeEphemeral, viewportRef, canvasRef, applyViewport, setFollow]);

  // ── Local cursor broadcast + manual-pan detection ───────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onPointerMove = (event: PointerEvent) => {
      const world = toWorld(event.clientX, event.clientY);
      if (!world) return;
      lastLocalScreenRef.current = { x: world.sx, y: world.sy };

      const now = performance.now();
      if (now - lastCursorSentAtRef.current < CURSOR_SEND_INTERVAL_MS) return;
      lastCursorSentAtRef.current = now;
      sendEphemeral({ kind: "cursor", x: world.wx, y: world.wy });
    };

    // Any manual interaction breaks out of follow mode.
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerdown", breakFollow, true);
    canvas.addEventListener("wheel", breakFollow, { capture: true, passive: true });
    return () => {
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", breakFollow, true);
      canvas.removeEventListener("wheel", breakFollow, true);
    };
  }, [canvasRef, toWorld, sendEphemeral, breakFollow]);

  // ── Viewport broadcast (for followers / presenting) ─────────────────────
  useEffect(() => {
    let last: Viewport | null = null;
    let wasPresenting = false;

    const timer = window.setInterval(() => {
      const canvas = canvasRef.current;
      const viewport = viewportRef.current;
      if (!canvas || !viewport) return;

      const isPresenting = presentingRef.current;
      if (wasPresenting && !isPresenting) {
        wasPresenting = false;
        sendEphemeral({ kind: "viewport", x: 0, y: 0, scale: 1, present: false });
      }
      // A follower's viewport is driven by someone else; don't echo it back.
      if (followIdRef.current !== null) return;

      const changed =
        !last ||
        last.x !== viewport.x ||
        last.y !== viewport.y ||
        last.scale !== viewport.scale;
      if (!changed && !(isPresenting && !wasPresenting)) return;

      last = { ...viewport };
      wasPresenting = isPresenting;
      sendEphemeral({
        kind: "viewport",
        x: (canvas.clientWidth / 2 - viewport.x) / viewport.scale,
        y: (canvas.clientHeight / 2 - viewport.y) / viewport.scale,
        scale: viewport.scale,
        ...(isPresenting ? { present: true } : {}),
      });
    }, VIEWPORT_POLL_MS);

    return () => window.clearInterval(timer);
  }, [canvasRef, viewportRef, sendEphemeral]);

  // ── Cursor chat ("/") ────────────────────────────────────────────────
  const closeChat = useCallback(
    (keepBubble: boolean) => {
      setChatOpen(false);
      if (chatLingerTimerRef.current !== null) {
        window.clearTimeout(chatLingerTimerRef.current);
        chatLingerTimerRef.current = null;
      }
      if (keepBubble) {
        // Leave the message visible to others briefly, then clear it.
        chatLingerTimerRef.current = window.setTimeout(() => {
          sendEphemeral({ kind: "cursor_chat", text: null });
          setChatText("");
          chatLingerTimerRef.current = null;
        }, LOCAL_TEXT_LINGER_MS);
      } else {
        sendEphemeral({ kind: "cursor_chat", text: null });
        setChatText("");
      }
    },
    [sendEphemeral],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "/" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isTypingTarget(event.target)
      ) {
        return;
      }
      event.preventDefault();
      const canvas = canvasRef.current;
      const pos = lastLocalScreenRef.current ?? {
        x: (canvas?.clientWidth ?? 600) / 2,
        y: (canvas?.clientHeight ?? 400) / 2,
      };
      if (chatLingerTimerRef.current !== null) {
        window.clearTimeout(chatLingerTimerRef.current);
        chatLingerTimerRef.current = null;
      }
      setChatPos(pos);
      setChatText("");
      setChatOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canvasRef]);

  useEffect(() => {
    if (chatOpen) chatInputRef.current?.focus();
  }, [chatOpen]);

  useEffect(
    () => () => {
      if (chatLingerTimerRef.current !== null) {
        window.clearTimeout(chatLingerTimerRef.current);
      }
    },
    [],
  );

  // ── Reactions ────────────────────────────────────────────────────────
  const sendReaction = (emoji: string) => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport) return;
    const screen = lastLocalScreenRef.current ?? {
      x: canvas.clientWidth / 2,
      y: canvas.clientHeight / 2,
    };
    const wx = (screen.x - viewport.x) / viewport.scale;
    const wy = (screen.y - viewport.y) / viewport.scale;
    sendEphemeral({ kind: "reaction", emoji, x: wx, y: wy });

    const id = (reactionIdRef.current += 1);
    setReactions((previous) => [
      ...previous.slice(-30),
      { id, emoji, name: "", left: screen.x, top: screen.y },
    ]);
    window.setTimeout(() => {
      setReactions((previous) => previous.filter((r) => r.id !== id));
    }, REACTION_LIFETIME_MS);
  };

  const togglePresenting = () => {
    const next = !presentingRef.current;
    presentingRef.current = next;
    setPresenting(next);
    if (next) setFollow(null);
  };

  // ── RAF: ease + place remote cursors ────────────────────────────────
  useEffect(() => {
    let raf = 0;
    let lastFrame = performance.now();

    const tick = (frameTime: number) => {
      const dt = Math.min(64, frameTime - lastFrame);
      lastFrame = frameTime;
      // Frame-rate independent exponential smoothing.
      const alpha = 1 - Math.exp(-dt / 55);
      const viewport = viewportRef.current;
      const now = Date.now();

      if (viewport) {
        for (const [userId, cursor] of cursorsRef.current) {
          const elem = cursorElemsRef.current.get(userId);
          if (!elem) continue;

          cursor.dx += (cursor.wx - cursor.dx) * alpha;
          cursor.dy += (cursor.wy - cursor.dy) * alpha;

          const visible = now - cursor.lastMoveAt < CURSOR_IDLE_HIDE_MS;
          elem.style.opacity = visible ? "1" : "0";
          elem.style.transform = `translate3d(${
            cursor.dx * viewport.scale + viewport.x
          }px, ${cursor.dy * viewport.scale + viewport.y}px, 0)`;

          const bubble = bubbleElemsRef.current.get(userId);
          if (bubble) {
            const showText =
              cursor.text !== null &&
              now - cursor.lastTextAt < CURSOR_TEXT_HIDE_MS;
            bubble.style.display = showText ? "block" : "none";
            if (showText && bubble.textContent !== cursor.text) {
              bubble.textContent = cursor.text;
            }
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [viewportRef]);

  // Drop cursors of users who left the room.
  useEffect(() => {
    const present = new Set(presenceState.presences.map((p) => p.userId));
    let changed = false;
    for (const userId of cursorsRef.current.keys()) {
      if (!present.has(userId)) {
        cursorsRef.current.delete(userId);
        changed = true;
      }
    }
    if (changed) setCursorIds(Array.from(cursorsRef.current.keys()));
    if (followIdRef.current && !present.has(followIdRef.current)) {
      setFollow(null);
    }
  }, [presenceState.presences, setFollow]);

  // Tick the countdown and chime once when it hits zero.
  useEffect(() => {
    if (!timer) return;
    const interval = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= timer.deadline && !timerFiredRef.current) {
        timerFiredRef.current = true;
        playTimerChime();
        setTimesUpUntil(current + TIMES_UP_VISIBLE_MS);
        window.setTimeout(() => setTimer(null), TIMES_UP_VISIBLE_MS);
      }
    }, 250);
    return () => window.clearInterval(interval);
  }, [timer]);

  const startTimer = (minutes: number | null) => {
    setTimerMenuOpen(false);
    timerFiredRef.current = false;
    setTimesUpUntil(0);
    if (minutes === null) {
      setTimer(null);
      sendEphemeral({ kind: "timer", remainingMs: null });
      return;
    }
    const remainingMs = minutes * 60_000;
    setTimer({ deadline: Date.now() + remainingMs, by: "you" });
    setNow(Date.now());
    sendEphemeral({ kind: "timer", remainingMs });
  };

  // Esc leaves follow mode.
  useEffect(() => {
    if (!followId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") breakFollow();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [followId, breakFollow]);

  const chipBase = isDark
    ? "border-white/15 bg-[#171717]/90 text-white/90"
    : "border-slate-300/80 bg-white/90 text-slate-700";

  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      <style>{`
        @keyframes canvasio-reaction-float {
          0% { transform: translate(-50%, 0) scale(0.6); opacity: 0; }
          15% { opacity: 1; transform: translate(-50%, -12px) scale(1.15); }
          100% { transform: translate(-50%, -110px) scale(1); opacity: 0; }
        }
      `}</style>

      {cursorIds.map((userId) => {
        const color = getPresenceColor(userId);
        const name = namesById.get(userId) ?? cursorsRef.current.get(userId)?.name ?? "Guest";
        return (
          <div
            key={userId}
            ref={(node) => {
              if (node) cursorElemsRef.current.set(userId, node);
              else cursorElemsRef.current.delete(userId);
            }}
            className="absolute left-0 top-0 transition-opacity duration-300"
            style={{ opacity: 0, willChange: "transform" }}
          >
            <svg width="18" height="20" viewBox="0 0 18 20" fill="none">
              <path
                d="M1 1l6.5 17 2.6-7 7-2.6L1 1z"
                fill={color}
                stroke="white"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
            </svg>
            <div
              className="ml-3 -mt-0.5 w-fit rounded-full px-2 py-0.5 text-[10px] font-semibold text-white shadow-md"
              style={{ background: color }}
            >
              {name}
            </div>
            <div
              ref={(node) => {
                if (node) bubbleElemsRef.current.set(userId, node);
                else bubbleElemsRef.current.delete(userId);
              }}
              className="ml-3 mt-1 hidden max-w-56 wrap-break-word rounded-2xl rounded-tl-sm px-3 py-1.5 text-xs font-medium text-white shadow-lg"
              style={{ background: color }}
            />
          </div>
        );
      })}

      {reactions.map((reaction) => (
        <div
          key={reaction.id}
          className="absolute text-3xl"
          style={{
            left: reaction.left,
            top: reaction.top,
            animation: `canvasio-reaction-float ${REACTION_LIFETIME_MS}ms ease-out forwards`,
          }}
        >
          {reaction.emoji}
          {reaction.name && (
            <div className="mt-0.5 text-center text-[9px] font-semibold text-slate-500">
              {reaction.name}
            </div>
          )}
        </div>
      ))}

      {chatOpen && (
        <div
          className="pointer-events-auto absolute"
          style={{ left: chatPos.x + 14, top: chatPos.y + 14 }}
        >
          <input
            ref={chatInputRef}
            value={chatText}
            maxLength={140}
            placeholder="Say something…"
            onChange={(event) => {
              setChatText(event.target.value);
              sendEphemeral({ kind: "cursor_chat", text: event.target.value });
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                closeChat(chatText.trim().length > 0);
              } else if (event.key === "Escape") {
                closeChat(false);
              }
            }}
            onBlur={() => closeChat(chatText.trim().length > 0)}
            className={`w-56 rounded-full border px-3 py-1.5 text-xs outline-none shadow-lg ${chipBase}`}
          />
        </div>
      )}

      <div className="pointer-events-auto absolute bottom-4 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2">
        {voice.error && (
          <div className="max-w-xs rounded-lg bg-rose-600 px-3 py-1.5 text-center text-xs font-medium text-white shadow-lg">
            {voice.error}
          </div>
        )}

        {timer && (
          <div
            role="timer"
            aria-live="off"
            className={`flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-semibold text-white shadow-lg ${
              timesUpUntil > now
                ? "bg-rose-600"
                : timer.deadline - now <= 10_000
                  ? "animate-pulse bg-rose-500"
                  : "bg-slate-800"
            }`}
          >
            <span aria-hidden>⏱</span>
            {timesUpUntil > now ? "Time's up!" : formatClock(timer.deadline - now)}
            {timer.label && <span className="text-xs font-normal opacity-80">{timer.label}</span>}
            {canControlTimer && (
              <button
                type="button"
                onClick={() => startTimer(null)}
                className="ml-1 rounded-full bg-white/15 px-2 text-xs font-normal hover:bg-white/25"
                aria-label="Stop timer"
              >
                Stop
              </button>
            )}
          </div>
        )}

        {followId && (
          <button
            type="button"
            onClick={breakFollow}
            className="rounded-full px-3 py-1.5 text-xs font-semibold text-white shadow-lg"
            style={{ background: getPresenceColor(followId) }}
          >
            Following {namesById.get(followId) ?? "user"} · click or Esc to stop
          </button>
        )}

        {remoteUsers.length > 0 && (
          <div className="flex max-w-[70vw] flex-wrap justify-center gap-1.5">
            {remoteUsers.map((user) => {
              const active = followId === user.userId;
              const inVoice = voice.participants.has(user.userId);
              const isSpeaking = voice.speaking.has(user.userId);
              return (
                <button
                  key={user.userId}
                  type="button"
                  title={active ? "Stop following" : `Follow ${user.userName}`}
                  onClick={() => {
                    if (active) {
                      breakFollow();
                      return;
                    }
                    dismissedPresenterRef.current = null;
                    setFollow(user.userId);
                  }}
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium shadow transition ${chipBase} ${
                    isSpeaking ? "ring-2 ring-emerald-400" : ""
                  }`}
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: getPresenceColor(user.userId) }}
                  />
                  {user.userName}
                  {inVoice && (
                    <span aria-label="In voice chat" title="In voice chat">
                      🎙
                    </span>
                  )}
                  {active && <span aria-hidden>👁</span>}
                </button>
              );
            })}
          </div>
        )}

        <div
          className={`flex items-center gap-1 rounded-full border px-2 py-1 shadow-lg backdrop-blur-xl ${chipBase}`}
        >
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React ${emoji}`}
              onClick={() => sendReaction(emoji)}
              className="rounded-full px-1 text-base transition-transform hover:scale-125 active:scale-95"
            >
              {emoji}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-current opacity-20" />
          {voice.joined ? (
            <>
              <button
                type="button"
                onClick={voice.toggleMute}
                title={voice.muted ? "Unmute" : "Mute"}
                aria-label={voice.muted ? "Unmute microphone" : "Mute microphone"}
                aria-pressed={voice.muted}
                className={`rounded-full px-1.5 text-base ${
                  voice.speaking.has(currentUserId ?? "") && !voice.muted
                    ? "ring-2 ring-emerald-400"
                    : ""
                }`}
              >
                {voice.muted ? "🔇" : "🎙"}
              </button>
              <button
                type="button"
                onClick={voice.leave}
                title="Leave voice chat"
                className="rounded-full bg-rose-500 px-2 py-0.5 text-[11px] font-semibold text-white"
              >
                Leave
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void voice.join()}
              title={
                voice.participants.size > 0
                  ? `Join voice chat (${voice.participants.size} in call)`
                  : "Start a voice chat — peer-to-peer, never recorded"
              }
              aria-label="Join voice chat"
              className="relative rounded-full px-1.5 text-base opacity-80 hover:opacity-100"
            >
              🎧
              {voice.participants.size > 0 && (
                <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-emerald-500 px-1 text-[9px] font-bold text-white">
                  {voice.participants.size}
                </span>
              )}
            </button>
          )}
          {canControlTimer && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setTimerMenuOpen((open) => !open)}
                title="Start a shared countdown for everyone"
                aria-label="Timer"
                aria-expanded={timerMenuOpen}
                className="rounded-full px-1.5 text-base opacity-80 hover:opacity-100"
              >
                ⏱
              </button>
              {timerMenuOpen && (
                <div
                  className={`absolute bottom-full left-1/2 mb-2 flex -translate-x-1/2 gap-1 rounded-xl border p-1.5 shadow-xl ${chipBase}`}
                >
                  {TIMER_PRESETS_MIN.map((minutes) => (
                    <button
                      key={minutes}
                      type="button"
                      onClick={() => startTimer(minutes)}
                      className="whitespace-nowrap rounded-lg px-2.5 py-1 text-xs font-semibold hover:bg-blue-500/20"
                    >
                      {minutes} min
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={togglePresenting}
            title="Everyone in the room follows your view"
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              presenting ? "bg-rose-500 text-white" : "opacity-80 hover:opacity-100"
            }`}
          >
            {presenting ? "Stop presenting" : "Present"}
          </button>
        </div>
      </div>
    </div>
  );
}
