"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { EphemeralEvent } from "@repo/common";

type EphemeralBroadcast = {
  senderId: string;
  senderName: string;
  event: EphemeralEvent;
};

const REFRESH_MS = 2500; // how often we re-announce while the draft is changing
const EXPIRE_MS = 4500; // drop a typist we haven't heard from

/**
 * Group-chat "X is typing…". Announces at most every REFRESH_MS while the local
 * draft changes, and retires remote typists that go quiet, so a dropped
 * connection can never leave a stuck indicator.
 */
export function useTypingIndicators({
  currentUserId,
  sendEphemeral,
  subscribeEphemeral,
}: {
  currentUserId: string | null;
  sendEphemeral: (event: EphemeralEvent) => boolean;
  subscribeEphemeral: (listener: (message: EphemeralBroadcast) => void) => () => void;
}) {
  const [typing, setTyping] = useState<Record<string, { name: string; until: number }>>({});
  const lastSentRef = useRef(0);
  const announcedRef = useRef(false);

  useEffect(() => {
    return subscribeEphemeral((message) => {
      if (message.event.kind !== "typing" || message.senderId === currentUserId) return;
      const { senderId, senderName } = message;
      const on = message.event.on;
      setTyping((prev) => {
        if (!on) {
          if (!(senderId in prev)) return prev;
          const next = { ...prev };
          delete next[senderId];
          return next;
        }
        return { ...prev, [senderId]: { name: senderName, until: Date.now() + EXPIRE_MS } };
      });
    });
  }, [currentUserId, subscribeEphemeral]);

  useEffect(() => {
    const id = setInterval(() => {
      setTyping((prev) => {
        const now = Date.now();
        const alive = Object.entries(prev).filter(([, v]) => v.until > now);
        return alive.length === Object.keys(prev).length ? prev : Object.fromEntries(alive);
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  /** Call on every draft change. */
  const notifyTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastSentRef.current < REFRESH_MS) return;
    lastSentRef.current = now;
    announcedRef.current = true;
    sendEphemeral({ kind: "typing", on: true });
  }, [sendEphemeral]);

  /** Call when the draft is sent, cleared or abandoned. */
  const stopTyping = useCallback(() => {
    if (!announcedRef.current) return;
    announcedRef.current = false;
    lastSentRef.current = 0;
    sendEphemeral({ kind: "typing", on: false });
  }, [sendEphemeral]);

  return { typingNames: Object.values(typing).map((t) => t.name), notifyTyping, stopTyping };
}
