"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RoomPresenceState } from "@repo/common";
import type {
  CanvasChatMessage,
  UseCanvasChatResult,
} from "../../hooks/useCanvasChat";

/*
 * Room messenger. Deliberately not a bubble chat: it reads like a printed
 * transcript (name, time, text) on the same paper/ink surface as the canvas
 * chrome, so a conversation feels like marginalia on the board.
 */

type CanvasMessengerProps = {
  currentUserId: string | null;
  roomKey: string | null;
  connectedUsersCount: number;
  presenceState: RoomPresenceState;
  selectedShapeIds: string[];
  isDark: boolean;
  syncStatus: "connected" | "disconnected" | "error";
  chat: UseCanvasChatResult;
  /** Controlled open state, so the page can keep the messenger and assistant from overlapping. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names of people currently typing in the group chat. */
  typingNames?: string[];
  onTyping?: () => void;
  onStopTyping?: () => void;
  /** Pan the canvas to a commented shape. */
  onFocusShape?: (shapeId: string) => void;
};

type MessengerTab = "group" | "direct" | "comments";

const GROUP_WINDOW_MS = 5 * 60 * 1000;
const URL_PATTERN = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g;
const AVATAR_COLORS = ["#b5472e", "#4f7a54", "#3c6585", "#a8801f", "#76598a", "#80664a"];

function hashColor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1]![0]! : "")).toUpperCase();
}

function formatTime(isoDate: string) {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(isoDate));
  } catch {
    return isoDate;
  }
}

function dayKey(isoDate: string) {
  const d = new Date(isoDate);
  return Number.isNaN(d.getTime()) ? isoDate : d.toDateString();
}

function formatDayLabel(isoDate: string) {
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return isoDate;
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  }).format(d);
}

function shortShapeId(shapeId: string | null | undefined) {
  if (!shapeId) return "shape";
  return shapeId.length > 8 ? shapeId.slice(0, 6) : shapeId;
}

function Avatar({ id, name, size = 28 }: { id: string; name: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-[5px] font-mono font-semibold text-white"
      style={{ width: size, height: size, background: hashColor(id), fontSize: size * 0.38 }}
    >
      {initials(name)}
    </span>
  );
}

/** Message text with http(s) links made clickable (opened safely in a new tab). */
function LinkifiedText({ text }: { text: string }) {
  return (
    <>
      {text.split(URL_PATTERN).map((part, i) =>
        i % 2 === 1 ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all !text-signal !underline decoration-signal/40 underline-offset-2 hover:decoration-signal"
          >
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

function Row({
  message,
  isMine,
  grouped,
  onFocusShape,
  showShape,
}: {
  message: CanvasChatMessage;
  isMine: boolean;
  grouped: boolean;
  onFocusShape?: (shapeId: string) => void;
  showShape: boolean;
}) {
  const failed = message.deliveryState === "failed";
  return (
    <div className={`group relative flex gap-2.5 ${grouped ? "pt-0.5" : "pt-3"}`}>
      <div className="w-7 shrink-0">
        {grouped ? (
          <span className="invisible font-mono text-[10px] text-ink-3 group-hover:visible">
            {formatTime(message.createdAt).replace(/\s?[AP]M/i, "")}
          </span>
        ) : (
          <Avatar id={message.sender.id} name={message.sender.name} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="text-[12.5px] font-semibold text-ink">
              {isMine ? "You" : message.sender.name}
            </span>
            <span className="font-mono text-[10px] tracking-tight text-ink-3">
              {formatTime(message.createdAt)}
            </span>
          </div>
        )}
        {showShape && message.shapeId && (
          <button
            type="button"
            onClick={() => onFocusShape?.(message.shapeId!)}
            disabled={!onFocusShape}
            title="Show this shape on the canvas"
            className="mb-0.5 mt-0.5 inline-flex items-center gap-1 rounded-[3px] border border-rule px-1.5 py-px font-mono text-[10px] text-ink-2 transition hover:border-signal hover:text-signal disabled:hover:border-rule disabled:hover:text-ink-2"
          >
            <span aria-hidden="true">◎</span>
            {shortShapeId(message.shapeId)}
          </button>
        )}
        <p
          className={`whitespace-pre-wrap break-words text-[13.5px] leading-[1.45] [overflow-wrap:anywhere] ${
            failed ? "text-signal" : "text-ink"
          } ${message.deliveryState === "sending" ? "opacity-55" : ""}`}
        >
          <LinkifiedText text={message.body} />
        </p>
        {failed && (
          <p className="mt-0.5 font-mono text-[10.5px] text-signal">
            Not sent{message.failureReason ? ` — ${message.failureReason}` : ""}
          </p>
        )}
      </div>
    </div>
  );
}

function MessageList({
  messages,
  currentUserId,
  showShape = false,
  onFocusShape,
}: {
  messages: CanvasChatMessage[];
  currentUserId: string | null;
  showShape?: boolean;
  onFocusShape?: (shapeId: string) => void;
}) {
  return (
    <>
      {messages.map((message, i) => {
        const prev = messages[i - 1];
        const newDay = !prev || dayKey(prev.createdAt) !== dayKey(message.createdAt);
        const grouped =
          !newDay &&
          prev !== undefined &&
          prev.sender.id === message.sender.id &&
          (prev.shapeId ?? null) === (message.shapeId ?? null) &&
          Date.parse(message.createdAt) - Date.parse(prev.createdAt) < GROUP_WINDOW_MS;
        return (
          <div key={message.id}>
            {newDay && (
              <div className="flex items-center gap-3 pb-1 pt-4 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-3">
                <span className="h-px flex-1 bg-rule" />
                {formatDayLabel(message.createdAt)}
                <span className="h-px flex-1 bg-rule" />
              </div>
            )}
            <Row
              message={message}
              isMine={message.sender.id === currentUserId}
              grouped={grouped}
              showShape={showShape && !grouped}
              onFocusShape={onFocusShape}
            />
          </div>
        );
      })}
    </>
  );
}

/**
 * Scroll container that follows new messages only while you're at the bottom
 * (or when you wrote the message); otherwise it offers a "new messages" jump
 * instead of yanking you away from history you're reading.
 */
function Transcript({
  children,
  count,
  lastIsMine,
  resetKey,
  footer,
}: {
  children: React.ReactNode;
  count: number;
  lastIsMine: boolean;
  resetKey: string;
  footer?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const prevCountRef = useRef(0);
  const [hasNew, setHasNew] = useState(false);

  const toBottom = useCallback((smooth: boolean) => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    setHasNew(false);
  }, []);

  useEffect(() => {
    stickRef.current = true;
    prevCountRef.current = 0;
    setHasNew(false);
    requestAnimationFrame(() => toBottom(false));
  }, [resetKey, toBottom]);

  useEffect(() => {
    const grew = count > prevCountRef.current;
    const first = prevCountRef.current === 0;
    prevCountRef.current = count;
    if (!grew) return;
    if (first || stickRef.current || lastIsMine) requestAnimationFrame(() => toBottom(!first));
    else setHasNew(true);
  }, [count, lastIsMine, toBottom]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={ref}
        onScroll={() => {
          const el = ref.current;
          if (!el) return;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
          if (stickRef.current) setHasNew(false);
        }}
        className="canvas-hide-scrollbar h-full overflow-y-auto px-4 pb-2"
      >
        {children}
        {footer}
      </div>
      {hasNew && (
        <button
          type="button"
          onClick={() => toBottom(true)}
          className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-[4px] bg-ink px-2.5 py-1 font-mono text-[10.5px] text-paper shadow-md"
        >
          ↓ New messages
        </button>
      )}
    </div>
  );
}

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="px-1 pt-10 text-center">
      <p className="font-display text-[26px] italic leading-none text-ink-2">{title}</p>
      <p className="mx-auto mt-2 max-w-[17rem] text-[12px] leading-relaxed text-ink-3">{hint}</p>
    </div>
  );
}

function Composer({
  value,
  onChange,
  onSend,
  placeholder,
  disabled = false,
  onActivity,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  placeholder: string;
  disabled?: boolean;
  onActivity?: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    // Shrink back after the draft is sent/cleared.
    if (!value && textareaRef.current) textareaRef.current.style.height = "auto";
  }, [value]);
  const nearLimit = value.length > 1800;
  return (
    <div className="border-t border-rule px-3 pb-3 pt-2.5">
      <div
        className={`flex items-end gap-2 rounded-[6px] border border-rule bg-paper px-2.5 py-1.5 transition focus-within:border-ink ${
          disabled ? "opacity-50" : ""
        }`}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            if (event.target.value) onActivity?.();
            const el = event.target;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 104)}px`;
          }}
          maxLength={2000}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSend();
            }
          }}
          disabled={disabled}
          rows={1}
          placeholder={placeholder}
          className="max-h-[104px] min-h-[28px] flex-1 resize-none bg-transparent py-1 text-[13.5px] text-ink outline-none placeholder:text-ink-3"
        />
        <button
          type="button"
          onClick={onSend}
          disabled={disabled || value.trim().length === 0}
          className="mb-0.5 shrink-0 rounded-[4px] bg-ink px-2.5 py-1 font-mono text-[11px] font-medium text-paper transition enabled:hover:bg-signal disabled:cursor-not-allowed disabled:opacity-30"
          title="Send (Enter)"
        >
          Send ↵
        </button>
      </div>
      {nearLimit && (
        <p className="mt-1 text-right font-mono text-[10px] text-ink-3">{value.length}/2000</p>
      )}
    </div>
  );
}

export function CanvasMessenger({
  currentUserId,
  roomKey,
  connectedUsersCount,
  selectedShapeIds,
  syncStatus,
  chat,
  open: isOpen,
  onOpenChange,
  typingNames,
  onTyping,
  onStopTyping,
  onFocusShape,
}: CanvasMessengerProps) {
  const setIsOpen = onOpenChange;
  const [activeTab, setActiveTab] = useState<MessengerTab>("group");
  const [groupDraft, setGroupDraft] = useState("");
  const [directDraft, setDirectDraft] = useState("");
  const [commentDraft, setCommentDraft] = useState("");
  const [selectedPartnerId, setSelectedPartnerId] = useState<string | null>(
    null,
  );
  const [commentView, setCommentView] = useState<"all" | "selected">("all");
  const [composerError, setComposerError] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [directUnreadCount, setDirectUnreadCount] = useState(0);
  const [seenGeneralMessageId, setSeenGeneralMessageId] = useState(0);
  const [seenDirectMessageId, setSeenDirectMessageId] = useState(0);
  const hasInitializedGeneralSeenRef = useRef(false);
  const hasInitializedDirectSeenRef = useRef(false);

  const selectedShapeId = selectedShapeIds[0] ?? null;
  const canAttemptSend = true;
  const seenGeneralStorageKey = roomKey
    ? `canvas-messenger:seen-general:${roomKey}`
    : null;
  const seenDirectStorageKey = roomKey
    ? `canvas-messenger:seen-direct:${roomKey}`
    : null;

  useEffect(() => {
    hasInitializedGeneralSeenRef.current = false;
    hasInitializedDirectSeenRef.current = false;
    setSeenGeneralMessageId(0);
    setSeenDirectMessageId(0);
    setUnreadCount(0);
    setDirectUnreadCount(0);
  }, [roomKey]);

  useEffect(() => {
    if (selectedShapeId) {
      setCommentView("selected");
    }
  }, [selectedShapeId]);

  useEffect(() => {
    if (chat.dmParticipants.length === 0) {
      setSelectedPartnerId(null);
      return;
    }

    const stillExists = chat.dmParticipants.some(
      (participant) => participant.id === selectedPartnerId,
    );
    if (stillExists) {
      return;
    }

    const nextPartner =
      chat.dmParticipants.find((participant) => participant.isOnline) ??
      chat.dmParticipants[0];
    setSelectedPartnerId(nextPartner?.id ?? null);
  }, [chat.dmParticipants, selectedPartnerId]);

  const selectedPartner = useMemo(
    () =>
      chat.dmParticipants.find(
        (participant) => participant.id === selectedPartnerId,
      ) ?? null,
    [chat.dmParticipants, selectedPartnerId],
  );

  const directMessagesForPartner = useMemo(() => {
    if (!selectedPartnerId) return [];
    return chat.getDirectMessagesForUser(selectedPartnerId);
  }, [chat, selectedPartnerId]);

  const visibleComments = useMemo(() => {
    if (commentView === "selected" && selectedShapeId) {
      return chat.commentsByShapeId.get(selectedShapeId) ?? [];
    }

    return chat.comments;
  }, [chat.comments, chat.commentsByShapeId, commentView, selectedShapeId]);

  const generalIncomingMessages = useMemo(
    () =>
      [...chat.groupMessages, ...chat.comments].filter(
        (message) => message.id > 0 && !message.optimistic,
      ),
    [chat.comments, chat.groupMessages],
  );

  const directIncomingMessages = useMemo(
    () =>
      chat.directMessages.filter(
        (message) =>
          message.id > 0 &&
          !message.optimistic &&
          message.sender.id !== currentUserId,
      ),
    [chat.directMessages, currentUserId],
  );

  const maxGeneralMessageId = useMemo(
    () =>
      generalIncomingMessages.reduce(
        (maxId, message) => Math.max(maxId, message.id),
        0,
      ),
    [generalIncomingMessages],
  );

  const maxDirectMessageId = useMemo(
    () =>
      directIncomingMessages.reduce(
        (maxId, message) => Math.max(maxId, message.id),
        0,
      ),
    [directIncomingMessages],
  );

  useEffect(() => {
    if (chat.isLoading || hasInitializedGeneralSeenRef.current) {
      return;
    }

    let baselineId = maxGeneralMessageId;
    if (seenGeneralStorageKey) {
      const storedRaw = window.localStorage.getItem(seenGeneralStorageKey);
      const stored = storedRaw ? Number(storedRaw) : Number.NaN;
      if (Number.isFinite(stored) && stored >= 0) {
        baselineId = Math.max(0, stored);
      }
    }

    hasInitializedGeneralSeenRef.current = true;
    setSeenGeneralMessageId(baselineId);
  }, [chat.isLoading, maxGeneralMessageId, seenGeneralStorageKey]);

  useEffect(() => {
    if (chat.isLoading || hasInitializedDirectSeenRef.current) {
      return;
    }

    let baselineId = maxDirectMessageId;
    if (seenDirectStorageKey) {
      const storedRaw = window.localStorage.getItem(seenDirectStorageKey);
      const stored = storedRaw ? Number(storedRaw) : Number.NaN;
      if (Number.isFinite(stored) && stored >= 0) {
        baselineId = Math.max(0, stored);
      }
    }

    hasInitializedDirectSeenRef.current = true;
    setSeenDirectMessageId(baselineId);
  }, [chat.isLoading, maxDirectMessageId, seenDirectStorageKey]);

  useEffect(() => {
    if (!hasInitializedGeneralSeenRef.current || chat.isLoading) {
      return;
    }

    const isReadingGeneral =
      isOpen && (activeTab === "group" || activeTab === "comments");
    if (!isReadingGeneral || maxGeneralMessageId <= seenGeneralMessageId) {
      return;
    }

    setSeenGeneralMessageId(maxGeneralMessageId);
    if (seenGeneralStorageKey) {
      window.localStorage.setItem(
        seenGeneralStorageKey,
        String(maxGeneralMessageId),
      );
    }
  }, [
    activeTab,
    chat.isLoading,
    isOpen,
    maxGeneralMessageId,
    seenGeneralMessageId,
    seenGeneralStorageKey,
  ]);

  useEffect(() => {
    if (!hasInitializedDirectSeenRef.current || chat.isLoading) {
      return;
    }

    const isReadingDirect = isOpen && activeTab === "direct";
    if (!isReadingDirect || maxDirectMessageId <= seenDirectMessageId) {
      return;
    }

    setSeenDirectMessageId(maxDirectMessageId);
    if (seenDirectStorageKey) {
      window.localStorage.setItem(
        seenDirectStorageKey,
        String(maxDirectMessageId),
      );
    }
  }, [
    activeTab,
    chat.isLoading,
    isOpen,
    maxDirectMessageId,
    seenDirectMessageId,
    seenDirectStorageKey,
  ]);

  useEffect(() => {
    if (!hasInitializedGeneralSeenRef.current || chat.isLoading) {
      return;
    }

    if (isOpen && (activeTab === "group" || activeTab === "comments")) {
      setUnreadCount(0);
      return;
    }

    const nextUnread = generalIncomingMessages.reduce((count, message) => {
      if (message.sender.id === currentUserId) return count;
      return message.id > seenGeneralMessageId ? count + 1 : count;
    }, 0);
    setUnreadCount(nextUnread);
  }, [
    activeTab,
    chat.isLoading,
    currentUserId,
    generalIncomingMessages,
    isOpen,
    seenGeneralMessageId,
  ]);

  useEffect(() => {
    if (!hasInitializedDirectSeenRef.current || chat.isLoading) {
      return;
    }

    if (isOpen && activeTab === "direct") {
      setDirectUnreadCount(0);
      return;
    }

    const nextUnread = directIncomingMessages.reduce((count, message) => {
      return message.id > seenDirectMessageId ? count + 1 : count;
    }, 0);
    setDirectUnreadCount(nextUnread);
  }, [
    activeTab,
    chat.isLoading,
    directIncomingMessages,
    isOpen,
    seenDirectMessageId,
  ]);

  const totalUnreadCount = unreadCount + directUnreadCount;

  const sendGroupMessage = () => {
    const next = groupDraft.trim();
    if (!next) return;

    const sent = chat.sendGroupMessage(next);
    if (!sent) {
      setComposerError("Waiting for the connection — try again in a moment.");
      return;
    }

    setComposerError(null);
    setGroupDraft("");
    onStopTyping?.();
  };

  const sendDirectMessage = () => {
    const next = directDraft.trim();
    if (!next || !selectedPartnerId) return;

    const sent = chat.sendDirectMessage(selectedPartnerId, next);
    if (!sent) {
      setComposerError("Direct message could not be sent right now.");
      return;
    }

    setComposerError(null);
    setDirectDraft("");
  };

  const sendComment = () => {
    const next = commentDraft.trim();
    if (!next || !selectedShapeId) return;

    const sent = chat.sendComment(selectedShapeId, next);
    if (!sent) {
      setComposerError("Comment could not be attached right now.");
      return;
    }

    setComposerError(null);
    setCommentDraft("");
    setCommentView("selected");
  };

  const tabs: Array<{ id: MessengerTab; label: string; count?: number }> = [
    { id: "group", label: "Room" },
    { id: "direct", label: "Direct", count: directUnreadCount },
    { id: "comments", label: "Notes", count: chat.comments.length || undefined },
  ];
  const typingLabel =
    !typingNames || typingNames.length === 0
      ? null
      : typingNames.length === 1
        ? `${typingNames[0]} is typing`
        : typingNames.length === 2
          ? `${typingNames[0]} and ${typingNames[1]} are typing`
          : "Several people are typing";
  const onlineStack = chat.dmParticipants.filter((p) => p.isOnline).slice(0, 4);
  const lastOf = (list: CanvasChatMessage[]) => list[list.length - 1];
  const statusText =
    syncStatus === "connected" ? null : syncStatus === "error" ? "Connection problem" : "Reconnecting…";

  return (
    <>
      {isOpen ? (
        <section
          aria-label="Room messenger"
          className="absolute bottom-[8.25rem] right-4 z-40 flex h-[min(68dvh,38rem)] w-[min(94vw,26rem)] flex-col overflow-hidden rounded-[8px] border border-rule-strong bg-surface text-ink shadow-[0_1px_0_var(--rule),0_26px_50px_-22px_rgba(0,0,0,0.55)]"
          style={{ isolation: "isolate", contain: "layout paint", fontFamily: "var(--font-ui)" }}
        >
          <header className="flex items-end justify-between gap-3 px-4 pb-2 pt-3.5">
            <div className="min-w-0">
              <h2 className="font-display text-[28px] leading-none tracking-tight">Conversation</h2>
              <p className="mt-1.5 flex items-center gap-2 font-mono text-[10.5px] text-ink-3">
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    syncStatus === "connected" ? "bg-[#4f9a5b]" : "bg-signal"
                  }`}
                />
                {statusText ??
                  `${connectedUsersCount} ${connectedUsersCount === 1 ? "person" : "people"} here`}
                {onlineStack.length > 0 && (
                  <span className="ml-1 flex -space-x-1.5">
                    {onlineStack.map((p) => (
                      <span key={p.id} className="rounded-[5px] ring-2 ring-[var(--surface)]">
                        <Avatar id={p.id} name={p.name} size={16} />
                      </span>
                    ))}
                  </span>
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              aria-label="Close chat"
              className="grid h-7 w-7 place-items-center rounded-[4px] text-ink-3 transition hover:bg-paper-2 hover:text-ink"
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
              </svg>
            </button>
          </header>

          <nav className="flex gap-5 border-b border-rule px-4" role="tablist">
            {tabs.map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveTab(tab.id)}
                  className={`relative -mb-px flex items-center gap-1.5 border-b-2 py-2 text-[13px] font-medium transition ${
                    active
                      ? "border-ink text-ink"
                      : "border-transparent text-ink-3 hover:text-ink-2"
                  }`}
                >
                  {tab.label}
                  {tab.count ? (
                    <span
                      className={`font-mono text-[10px] ${
                        tab.id === "direct" ? "rounded-[3px] bg-signal px-1 text-white" : "text-ink-3"
                      }`}
                    >
                      {tab.count > 99 ? "99+" : tab.count}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>

          {(composerError || chat.error) && (
            <p className="px-4 pt-2 font-mono text-[11px] text-signal">{composerError ?? chat.error}</p>
          )}

          {activeTab === "group" && (
            <>
              <Transcript
                count={chat.groupMessages.length}
                lastIsMine={lastOf(chat.groupMessages)?.sender.id === currentUserId}
                resetKey="group"
                footer={
                  typingLabel ? (
                    <p className="flex items-center gap-1.5 pt-2 font-mono text-[10.5px] text-ink-3" aria-live="polite">
                      <span className="flex gap-0.5">
                        {[0, 0.15, 0.3].map((d) => (
                          <span
                            key={d}
                            className="inline-block h-1 w-1 rounded-full bg-ink-3"
                            style={{ animation: `bounce 0.9s ${d}s ease-in-out infinite` }}
                          />
                        ))}
                      </span>
                      {typingLabel}
                    </p>
                  ) : null
                }
              >
                {chat.isLoading && <p className="pt-4 font-mono text-[11px] text-ink-3">Loading…</p>}
                {!chat.isLoading && chat.groupMessages.length === 0 && (
                  <Empty
                    title="Nothing said yet."
                    hint="Anything you write here goes to everyone on this canvas. Keep it short, point at things."
                  />
                )}
                <MessageList messages={chat.groupMessages} currentUserId={currentUserId} />
              </Transcript>
              <Composer
                value={groupDraft}
                onChange={(v) => {
                  setGroupDraft(v);
                  if (!v) onStopTyping?.();
                }}
                onActivity={onTyping}
                onSend={sendGroupMessage}
                placeholder="Write to everyone on this canvas"
                disabled={!canAttemptSend}
              />
            </>
          )}

          {activeTab === "direct" && (
            <>
              <div className="canvas-hide-scrollbar flex gap-1 overflow-x-auto border-b border-rule px-3 py-2">
                {chat.dmParticipants.length === 0 && (
                  <p className="px-1 py-1 text-[12px] text-ink-3">
                    {connectedUsersCount > 1
                      ? "Loading collaborators…"
                      : "No one else is on this canvas yet."}
                  </p>
                )}
                {chat.dmParticipants.map((participant) => {
                  const active = participant.id === selectedPartnerId;
                  return (
                    <button
                      key={participant.id}
                      type="button"
                      onClick={() => setSelectedPartnerId(participant.id)}
                      className={`flex shrink-0 items-center gap-2 rounded-[5px] border px-2 py-1 text-[12.5px] transition ${
                        active
                          ? "border-ink bg-paper-2 text-ink"
                          : "border-transparent text-ink-2 hover:bg-paper-2"
                      }`}
                    >
                      <span className="relative">
                        <Avatar id={participant.id} name={participant.name} size={20} />
                        <span
                          className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-[var(--surface)] ${
                            participant.isOnline ? "bg-[#4f9a5b]" : "bg-ink-3/60"
                          }`}
                        />
                      </span>
                      {participant.name}
                    </button>
                  );
                })}
              </div>
              <Transcript
                count={directMessagesForPartner.length}
                lastIsMine={lastOf(directMessagesForPartner)?.sender.id === currentUserId}
                resetKey={`direct:${selectedPartnerId ?? ""}`}
              >
                {!selectedPartner ? (
                  <Empty title="Pick someone." hint="Direct messages are private between the two of you." />
                ) : directMessagesForPartner.length === 0 ? (
                  <Empty
                    title={`Just you and ${selectedPartner.name.split(" ")[0]}.`}
                    hint="Only the two of you can see this thread."
                  />
                ) : null}
                <MessageList messages={directMessagesForPartner} currentUserId={currentUserId} />
              </Transcript>
              <Composer
                value={directDraft}
                onChange={setDirectDraft}
                onSend={sendDirectMessage}
                placeholder={selectedPartner ? `Message ${selectedPartner.name}` : "Pick someone first"}
                disabled={!selectedPartner || !canAttemptSend}
              />
            </>
          )}

          {activeTab === "comments" && (
            <>
              <div className="flex items-center gap-1 border-b border-rule px-3 py-2 text-[12px]">
                {(["all", "selected"] as const).map((view) => {
                  const disabled = view === "selected" && !selectedShapeId;
                  const active = commentView === view && !disabled;
                  return (
                    <button
                      key={view}
                      type="button"
                      disabled={disabled}
                      onClick={() => setCommentView(view)}
                      className={`rounded-[4px] px-2 py-1 transition disabled:cursor-not-allowed disabled:opacity-40 ${
                        active ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-2"
                      }`}
                    >
                      {view === "all"
                        ? "Every note"
                        : selectedShapeId
                          ? `This shape · ${shortShapeId(selectedShapeId)}`
                          : "Select a shape"}
                    </button>
                  );
                })}
              </div>
              <Transcript
                count={visibleComments.length}
                lastIsMine={lastOf(visibleComments)?.sender.id === currentUserId}
                resetKey={`comments:${commentView}:${commentView === "selected" ? selectedShapeId : ""}`}
              >
                {visibleComments.length === 0 && (
                  <Empty
                    title="No notes here."
                    hint={
                      commentView === "selected" && selectedShapeId
                        ? "Nobody has commented on this shape yet."
                        : "Select a shape and write a note. It stays pinned to that shape."
                    }
                  />
                )}
                <MessageList
                  messages={visibleComments}
                  currentUserId={currentUserId}
                  showShape={commentView === "all"}
                  onFocusShape={onFocusShape}
                />
              </Transcript>
              <Composer
                value={commentDraft}
                onChange={setCommentDraft}
                onSend={sendComment}
                placeholder={
                  selectedShapeId ? `Note on ${shortShapeId(selectedShapeId)}` : "Select a shape to leave a note"
                }
                disabled={!selectedShapeId || !canAttemptSend}
              />
            </>
          )}
        </section>
      ) : null}

      <div className="absolute bottom-20 right-4 z-20">
        <button
          type="button"
          onClick={() => onOpenChange(!isOpen)}
          className="relative grid h-11 w-11 place-items-center rounded-[8px] border border-rule-strong bg-ink text-paper shadow-[3px_3px_0_var(--signal)] transition active:translate-x-px active:translate-y-px active:shadow-[2px_2px_0_var(--signal)]"
          aria-label={isOpen ? "Close canvas messenger" : "Open canvas messenger"}
        >
          <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round">
            <path d="M3 4.5h14v9H9.5L6 16.5v-3H3z" />
          </svg>
          {totalUnreadCount > 0 && !isOpen && (
            <span className="absolute -right-1.5 -top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-[4px] bg-signal px-1 font-mono text-[10px] font-semibold text-white">
              {totalUnreadCount > 9 ? "9+" : totalUnreadCount}
            </span>
          )}
        </button>
      </div>
    </>
  );
}
