"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RoomPresenceState } from "@repo/common";
import {
  MessageCircleMore,
  MessagesSquare,
  SendHorizontal,
  Users,
  X,
} from "lucide-react";
import type {
  CanvasChatMessage,
  UseCanvasChatResult,
} from "../../hooks/useCanvasChat";

type CanvasMessengerProps = {
  currentUserId: string | null;
  roomKey: string | null;
  connectedUsersCount: number;
  presenceState: RoomPresenceState;
  selectedShapeIds: string[];
  isDark: boolean;
  syncStatus: "connected" | "disconnected" | "error";
  chat: UseCanvasChatResult;
};

type MessengerTab = "group" | "direct" | "comments";

function formatTime(isoDate: string) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(isoDate));
  } catch {
    return isoDate;
  }
}

const GROUP_WINDOW_MS = 5 * 60 * 1000;
const URL_PATTERN = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g;

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

/** Message text with http(s) links made clickable (opened safely in a new tab). */
function LinkifiedText({ text, isMine }: { text: string; isMine: boolean }) {
  return (
    <>
      {text.split(URL_PATTERN).map((part, i) =>
        i % 2 === 1 ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className={`break-all underline underline-offset-2 ${isMine ? "text-white" : "text-[#0a7cff]"}`}
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

function shortShapeId(shapeId: string | null | undefined) {
  if (!shapeId) return "shape";
  return shapeId.length > 10 ? `${shapeId.slice(0, 8)}...` : shapeId;
}

function MessageBubble({
  message,
  isMine,
  isDark,
  showShapeId = false,
  grouped = false,
}: {
  message: CanvasChatMessage;
  isMine: boolean;
  isDark: boolean;
  showShapeId?: boolean;
  /** Same sender as the previous message within a few minutes: compact, no header. */
  grouped?: boolean;
}) {
  return (
    <div
      className={`flex ${isMine ? "justify-end" : "justify-start"} ${grouped ? "-mt-2" : ""}`}
      title={grouped ? formatTime(message.createdAt) : undefined}
    >
      <div
        className={`min-w-0 max-w-[82%] ${isMine ? "items-end" : "items-start"} flex flex-col`}
      >
        <div
          className={`mb-1 flex items-center gap-2 text-[11px] ${
            isDark ? "text-white/45" : "text-slate-500"
          } ${grouped && !(showShapeId && message.shapeId) ? "hidden" : ""}`}
        >
          {!grouped && <span>{isMine ? "You" : message.sender.name}</span>}
          {!grouped && <span>{formatTime(message.createdAt)}</span>}
          {showShapeId && message.shapeId ? (
            <span
              className={`rounded-full px-2 py-0.5 ${
                isDark
                  ? "bg-white/10 text-white/70"
                  : "bg-slate-100 text-slate-600"
              }`}
            >
              #{shortShapeId(message.shapeId)}
            </span>
          ) : null}
        </div>
        <div
          className={`max-w-full whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm shadow-sm [overflow-wrap:anywhere] ${
            message.deliveryState === "failed"
              ? isDark
                ? "border border-red-400/30 bg-red-500/12 text-red-100"
                : "border border-red-200 bg-red-50 text-red-700"
              : isMine
                ? "bg-[#0a7cff] text-white"
                : isDark
                  ? "border border-white/10 bg-[#1e1e1e] text-white/92"
                  : "border border-slate-200 bg-white text-slate-700"
          }`}
        >
          <LinkifiedText text={message.body} isMine={isMine} />
        </div>
        {message.deliveryState === "sending" ? (
          <div
            className={`mt-1 text-[11px] ${isDark ? "text-white/40" : "text-slate-400"}`}
          >
            Sending…
          </div>
        ) : null}
        {message.deliveryState === "failed" ? (
          <div
            className={`mt-1 text-[11px] ${isDark ? "text-red-300" : "text-red-600"}`}
          >
            {message.failureReason ?? "Failed to send"}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MessageList({
  messages,
  currentUserId,
  isDark,
  showShapeId = false,
}: {
  messages: CanvasChatMessage[];
  currentUserId: string | null;
  isDark: boolean;
  showShapeId?: boolean;
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
          <div key={message.id} className="contents">
            {newDay && (
              <div
                className={`flex items-center gap-3 text-[11px] ${isDark ? "text-white/35" : "text-slate-400"}`}
              >
                <span className={`h-px flex-1 ${isDark ? "bg-white/10" : "bg-slate-200"}`} />
                {formatDayLabel(message.createdAt)}
                <span className={`h-px flex-1 ${isDark ? "bg-white/10" : "bg-slate-200"}`} />
              </div>
            )}
            <MessageBubble
              message={message}
              isMine={message.sender.id === currentUserId}
              isDark={isDark}
              showShapeId={showShapeId}
              grouped={grouped}
            />
          </div>
        );
      })}
    </>
  );
}

function Composer({
  value,
  onChange,
  onSend,
  placeholder,
  isDark,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  placeholder: string;
  isDark: boolean;
  disabled?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    // Shrink back after the draft is sent/cleared.
    if (!value && textareaRef.current) textareaRef.current.style.height = "auto";
  }, [value]);
  return (
    <div
      className={`flex items-end gap-2 rounded-2xl border p-2 ${
        isDark ? "border-white/10 bg-[#161616]" : "border-slate-200 bg-white"
      }`}
    >
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          const el = event.target;
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
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
        className={`max-h-24 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none ${
          isDark
            ? "text-white placeholder:text-white/35"
            : "text-slate-700 placeholder:text-slate-400"
        } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
      />
      <button
        type="button"
        onClick={onSend}
        disabled={disabled || value.trim().length === 0}
        className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#0a7cff] text-white transition hover:bg-[#0670e7] disabled:cursor-not-allowed disabled:bg-[#8ebeff]"
        title="Send message"
      >
        <SendHorizontal className="h-4 w-4" />
      </button>
    </div>
  );
}

export function CanvasMessenger({
  currentUserId,
  roomKey,
  connectedUsersCount,
  selectedShapeIds,
  isDark,
  syncStatus,
  chat,
}: CanvasMessengerProps) {
  const [isOpen, setIsOpen] = useState(false);
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
  const scrollEndRef = useRef<HTMLDivElement | null>(null);
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
    scrollEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [
    activeTab,
    chat.comments.length,
    chat.directMessages.length,
    chat.groupMessages.length,
    selectedPartnerId,
    commentView,
  ]);

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

  const syncToneClass =
    syncStatus === "connected"
      ? "bg-green-500"
      : syncStatus === "error"
        ? "bg-red-500"
        : "bg-yellow-500";

  const panelSurface = isDark
    ? "border-white/10 bg-[#101114]/95 text-white"
    : "border-slate-200 bg-white/95 text-slate-800";
  const mutedText = isDark ? "text-white/55" : "text-slate-500";
  const scrollAreaClass = "canvas-hide-scrollbar";
  const totalUnreadCount = unreadCount + directUnreadCount;

  const sendGroupMessage = () => {
    const next = groupDraft.trim();
    if (!next) return;

    const sent = chat.sendGroupMessage(next);
    if (!sent) {
      setComposerError("Chat is waiting for the canvas connection.");
      return;
    }

    setComposerError(null);
    setGroupDraft("");
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

  return (
    <>
      {isOpen ? (
        <div
          className={`absolute bottom-20 right-4 z-30 flex h-[min(72dvh,38rem)] w-[min(92vw,25rem)] flex-col overflow-hidden rounded-[26px] border shadow-[0_28px_60px_rgba(15,23,42,0.28)] ${panelSurface}`}
          style={{
            backdropFilter: "blur(14px)",
            WebkitBackdropFilter: "blur(14px)",
            isolation: "isolate",
            contain: "layout paint",
          }}
        >
          <div className="flex items-center justify-between bg-linear-to-r from-[#0a7cff] via-[#1783ff] to-[#22a2ff] px-4 py-3 text-white">
            <div>
              <div className="text-sm font-semibold">Canvas Messenger</div>
              <div className="text-xs text-white/80">
                {connectedUsersCount}{" "}
                {connectedUsersCount === 1 ? "person here" : "people here"}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-white/15 transition hover:bg-white/25"
              aria-label="Close chat"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div
            className={`flex gap-2 border-b px-3 py-3 ${isDark ? "border-white/10" : "border-slate-200"}`}
          >
            {[
              { id: "group" as const, label: "Canvas", icon: Users },
              {
                id: "direct" as const,
                label: "Direct",
                icon: MessageCircleMore,
              },
              {
                id: "comments" as const,
                label: "Comments",
                icon: MessagesSquare,
              },
            ].map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;

              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`relative flex flex-1 items-center justify-center gap-2 rounded-full px-3 py-2 text-sm font-medium transition ${
                    isActive
                      ? "bg-[#0a7cff] text-white"
                      : isDark
                        ? "bg-white/5 text-white/75 hover:bg-white/10"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {tab.label}
                  {tab.id === "direct" && directUnreadCount > 0 ? (
                    <span className="absolute -right-1 -top-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white shadow-lg">
                      {directUnreadCount > 9 ? "9+" : directUnreadCount}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>

          {composerError ? (
            <div
              className={`px-4 pt-3 text-xs ${isDark ? "text-red-300" : "text-red-600"}`}
            >
              {composerError}
            </div>
          ) : null}

          {chat.error ? (
            <div
              className={`px-4 pt-3 text-xs ${isDark ? "text-red-300" : "text-red-600"}`}
            >
              {chat.error}
            </div>
          ) : null}

          {activeTab === "direct" && chat.participants.length > 0 ? (
            <div
              className={`border-b px-4 py-2 text-xs ${isDark ? "border-white/10 text-white/60" : "border-slate-200 text-slate-500"}`}
            >
              {chat.participants.length}{" "}
              {chat.participants.length === 1
                ? "participant available"
                : "participants available"}
            </div>
          ) : null}

          <div className="min-h-0 flex-1">
            {activeTab === "group" ? (
              <div className="flex h-full flex-col">
                <div className={`px-4 pt-3 text-xs ${mutedText}`}>
                  Canvas-wide chat for everyone in this room.
                </div>
                <div
                  className={`min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 ${scrollAreaClass}`}
                >
                  {chat.isLoading ? (
                    <div className={mutedText}>Loading messages...</div>
                  ) : null}
                  {!chat.isLoading && chat.groupMessages.length === 0 ? (
                    <div className={mutedText}>
                      Start the room conversation.
                    </div>
                  ) : null}
                  <MessageList
                    messages={chat.groupMessages}
                    currentUserId={currentUserId}
                    isDark={isDark}
                  />
                  <div ref={scrollEndRef} />
                </div>
                <div className="p-3">
                  <Composer
                    value={groupDraft}
                    onChange={setGroupDraft}
                    onSend={sendGroupMessage}
                    placeholder="Message everyone on the canvas"
                    isDark={isDark}
                    disabled={!canAttemptSend}
                  />
                </div>
              </div>
            ) : null}

            {activeTab === "direct" ? (
              <div className="flex h-full min-h-0 overflow-hidden">
                <div
                  className={`w-32 shrink-0 border-r p-2 ${isDark ? "border-white/10" : "border-slate-200"}`}
                >
                  <div
                    className={`mb-2 px-2 text-[11px] uppercase tracking-[0.18em] ${mutedText}`}
                  >
                    People
                  </div>
                  <div
                    className={`space-y-1 overflow-y-auto ${scrollAreaClass}`}
                  >
                    {chat.dmParticipants.length === 0 ? (
                      <div className={`px-2 text-xs ${mutedText}`}>
                        {connectedUsersCount > 1
                          ? "People are connected, but participant details are still loading."
                          : "No collaborators yet."}
                      </div>
                    ) : null}
                    {chat.dmParticipants.map((participant) => {
                      const isActive = participant.id === selectedPartnerId;
                      const latestMessage = chat
                        .getDirectMessagesForUser(participant.id)
                        .slice(-1)[0];

                      return (
                        <button
                          key={participant.id}
                          type="button"
                          onClick={() => setSelectedPartnerId(participant.id)}
                          className={`w-full rounded-2xl px-2 py-2 text-left transition ${
                            isActive
                              ? "bg-[#0a7cff] text-white"
                              : isDark
                                ? "hover:bg-white/5"
                                : "hover:bg-slate-100"
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className={`inline-flex h-2.5 w-2.5 rounded-full ${
                                participant.isOnline
                                  ? "bg-green-400"
                                  : isActive
                                    ? "bg-white/60"
                                    : "bg-slate-300"
                              }`}
                            />
                            <span className="truncate text-sm font-medium">
                              {participant.name}
                            </span>
                          </div>
                          <div
                            className={`mt-1 truncate text-[11px] ${isActive ? "text-white/75" : mutedText}`}
                          >
                            {latestMessage?.body ??
                              (participant.isOnline
                                ? "Online now"
                                : "No messages yet")}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  <div
                    className={`border-b px-4 py-3 ${isDark ? "border-white/10" : "border-slate-200"}`}
                  >
                    <div className="text-sm font-semibold">
                      {selectedPartner?.name ?? "Select someone"}
                    </div>
                    <div className={`text-xs ${mutedText}`}>
                      {selectedPartner
                        ? selectedPartner.isOnline
                          ? "Active on this canvas"
                          : "Room member"
                        : "Choose a teammate to DM"}
                    </div>
                  </div>
                  <div
                    className={`min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 ${scrollAreaClass}`}
                  >
                    {!selectedPartner ? (
                      <div className={mutedText}>
                        Pick a participant to start chatting.
                      </div>
                    ) : null}
                    {selectedPartner &&
                    directMessagesForPartner.length === 0 ? (
                      <div className={mutedText}>
                        Your personal thread with {selectedPartner.name} will
                        appear here.
                      </div>
                    ) : null}
                    <MessageList
                      messages={directMessagesForPartner}
                      currentUserId={currentUserId}
                      isDark={isDark}
                    />
                    <div ref={scrollEndRef} />
                  </div>
                  <div className="p-3">
                    <Composer
                      value={directDraft}
                      onChange={setDirectDraft}
                      onSend={sendDirectMessage}
                      placeholder={
                        selectedPartner
                          ? `Message ${selectedPartner.name}`
                          : "Select a collaborator first"
                      }
                      isDark={isDark}
                      disabled={!selectedPartner || !canAttemptSend}
                    />
                  </div>
                </div>
              </div>
            ) : null}

            {activeTab === "comments" ? (
              <div className="flex h-full flex-col">
                <div
                  className={`border-b px-4 py-3 ${isDark ? "border-white/10" : "border-slate-200"}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setCommentView("all")}
                      className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                        commentView === "all"
                          ? "bg-[#0a7cff] text-white"
                          : isDark
                            ? "bg-white/5 text-white/75"
                            : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      All comments
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        selectedShapeId && setCommentView("selected")
                      }
                      disabled={!selectedShapeId}
                      className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                        commentView === "selected" && selectedShapeId
                          ? "bg-[#0a7cff] text-white"
                          : isDark
                            ? "bg-white/5 text-white/75"
                            : "bg-slate-100 text-slate-600"
                      } disabled:cursor-not-allowed disabled:opacity-45`}
                    >
                      {selectedShapeId
                        ? `Selected #${shortShapeId(selectedShapeId)}`
                        : "Select a shape to comment"}
                    </button>
                  </div>
                  <div className={`mt-2 text-xs ${mutedText}`}>
                    Comments stay attached to shapes and reload with the room
                    history.
                  </div>
                </div>
                <div
                  className={`min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 ${scrollAreaClass}`}
                >
                  {visibleComments.length === 0 ? (
                    <div className={mutedText}>
                      {commentView === "selected" && selectedShapeId
                        ? "No comments on this shape yet."
                        : "Shape comments will appear here."}
                    </div>
                  ) : null}
                  <MessageList
                    messages={visibleComments}
                    currentUserId={currentUserId}
                    isDark={isDark}
                    showShapeId={commentView === "all"}
                  />
                  <div ref={scrollEndRef} />
                </div>
                <div className="p-3">
                  <Composer
                    value={commentDraft}
                    onChange={setCommentDraft}
                    onSend={sendComment}
                    placeholder={
                      selectedShapeId
                        ? `Comment on #${shortShapeId(selectedShapeId)}`
                        : "Select a shape to leave a comment"
                    }
                    isDark={isDark}
                    disabled={!selectedShapeId || !canAttemptSend}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="absolute bottom-20 right-4 z-20">
        <div className="relative">
          <button
            type="button"
            onClick={() => setIsOpen((current) => !current)}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-linear-to-br from-[#0a7cff] via-[#1783ff] to-[#29a8ff] text-white shadow-[0_18px_38px_rgba(10,124,255,0.38)] transition hover:scale-[1.03]"
            aria-label={
              isOpen ? "Close canvas messenger" : "Open canvas messenger"
            }
          >
            <MessageCircleMore className="h-5 w-5" />
          </button>
          {totalUnreadCount > 0 ? (
            <span className="absolute -right-1 -top-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white shadow-lg">
              {totalUnreadCount > 9 ? "9+" : totalUnreadCount}
            </span>
          ) : null}
        </div>
      </div>

      <div className="absolute bottom-4 right-4 z-20">
        <div
          className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium backdrop-blur ${
            isDark
              ? "bg-[#151515]/88 text-white/88"
              : "bg-white/88 text-slate-700"
          }`}
        >
          <span className={`h-2.5 w-2.5 rounded-full ${syncToneClass}`} />
          {connectedUsersCount}{" "}
          {connectedUsersCount === 1 ? "user connected" : "users connected"}
        </div>
      </div>
    </>
  );
}
