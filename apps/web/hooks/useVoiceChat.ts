"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { EphemeralEvent } from "@repo/common";
import type { EphemeralBroadcast } from "./useCanvasSync";

/**
 * Peer-to-peer voice chat (WebRTC mesh). Signaling rides on the room's
 * WebSocket as `rtc` ephemeral events; audio never touches our servers and is
 * never recorded or stored.
 *
 * Glare avoidance: when two people are in the call, the one with the larger
 * user id sends the offer, so both sides always agree who initiates.
 *
 * STUN is used by default. Behind strict NATs a TURN relay is needed — set
 * NEXT_PUBLIC_TURN_URL / _USERNAME / _CREDENTIAL to enable one.
 */

type SignalData =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: RTCIceCandidateInit };

type Peer = {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  pendingIce: RTCIceCandidateInit[];
};

type UseVoiceChatOptions = {
  currentUserId: string | null;
  sendEphemeral: (event: EphemeralEvent) => boolean;
  subscribeEphemeral: (listener: (message: EphemeralBroadcast) => void) => () => void;
};

const SPEAKING_THRESHOLD = 0.035;
const SPEAKING_POLL_MS = 180;

function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
  const turnUrl = process.env.NEXT_PUBLIC_TURN_URL;
  if (turnUrl) {
    servers.push({
      urls: turnUrl,
      username: process.env.NEXT_PUBLIC_TURN_USERNAME,
      credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
    });
  }
  return servers;
}

export function useVoiceChat({
  currentUserId,
  sendEphemeral,
  subscribeEphemeral,
}: UseVoiceChatOptions) {
  const [joined, setJoined] = useState(false);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** userId → display name, for everyone currently in the call (including remote-only). */
  const [participants, setParticipants] = useState<Map<string, string>>(new Map());
  const [speaking, setSpeaking] = useState<Set<string>>(new Set());

  const joinedRef = useRef(false);
  const participantsRef = useRef<Map<string, string>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, Peer>>(new Map());
  const audioContextRef = useRef<AudioContext | null>(null);
  const analysersRef = useRef<Map<string, AnalyserNode>>(new Map());
  const currentUserIdRef = useRef(currentUserId);
  const sendRef = useRef(sendEphemeral);

  useEffect(() => {
    currentUserIdRef.current = currentUserId;
    sendRef.current = sendEphemeral;
  }, [currentUserId, sendEphemeral]);

  const sendSignal = useCallback((to: string, data: SignalData) => {
    sendRef.current({ kind: "rtc", to, data: JSON.stringify(data) });
  }, []);

  const watchLevel = useCallback((key: string, stream: MediaStream) => {
    try {
      const context = audioContextRef.current ?? new AudioContext();
      audioContextRef.current = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      analysersRef.current.set(key, analyser);
    } catch {
      // Speaking indicators are a nicety; the call works without them.
    }
  }, []);

  const closePeer = useCallback((userId: string) => {
    const peer = peersRef.current.get(userId);
    if (!peer) return;
    peer.pc.close();
    peer.audio.srcObject = null;
    peer.audio.remove();
    peersRef.current.delete(userId);
    analysersRef.current.delete(userId);
  }, []);

  const createPeer = useCallback(
    (userId: string) => {
      const existing = peersRef.current.get(userId);
      if (existing) return existing;

      const pc = new RTCPeerConnection({ iceServers: iceServers() });
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.setAttribute("playsinline", "true");
      document.body.appendChild(audio);

      const peer: Peer = { pc, audio, pendingIce: [] };
      peersRef.current.set(userId, peer);

      localStreamRef.current
        ?.getTracks()
        .forEach((track) => pc.addTrack(track, localStreamRef.current!));

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignal(userId, { type: "ice", candidate: event.candidate.toJSON() });
        }
      };
      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (!stream) return;
        audio.srcObject = stream;
        void audio.play().catch(() => undefined);
        watchLevel(userId, stream);
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          closePeer(userId);
        }
      };
      return peer;
    },
    [closePeer, sendSignal, watchLevel],
  );

  const callPeer = useCallback(
    async (userId: string) => {
      const peer = createPeer(userId);
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      if (offer.sdp) sendSignal(userId, { type: "offer", sdp: offer.sdp });
    },
    [createPeer, sendSignal],
  );

  const handleSignal = useCallback(
    async (from: string, data: SignalData) => {
      if (!joinedRef.current) return;
      const peer = createPeer(from);

      const flushIce = async () => {
        for (const candidate of peer.pendingIce.splice(0)) {
          await peer.pc.addIceCandidate(candidate).catch(() => undefined);
        }
      };

      if (data.type === "offer") {
        await peer.pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        if (answer.sdp) sendSignal(from, { type: "answer", sdp: answer.sdp });
        await flushIce();
      } else if (data.type === "answer") {
        await peer.pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
        await flushIce();
      } else if (peer.pc.remoteDescription) {
        await peer.pc.addIceCandidate(data.candidate).catch(() => undefined);
      } else {
        peer.pendingIce.push(data.candidate);
      }
    },
    [createPeer, sendSignal],
  );

  // Incoming voice presence + signaling.
  useEffect(() => {
    return subscribeEphemeral((message) => {
      const { event, senderId, senderName } = message;

      if (event.kind === "voice") {
        setParticipants((previous) => {
          const next = new Map(previous);
          if (event.on) next.set(senderId, senderName);
          else next.delete(senderId);
          participantsRef.current = next;
          return next;
        });
        if (event.on) {
          const me = currentUserIdRef.current;
          if (joinedRef.current && me && me > senderId) void callPeer(senderId).catch(() => undefined);
        } else {
          closePeer(senderId);
        }
        return;
      }

      if (event.kind === "rtc") {
        try {
          void handleSignal(senderId, JSON.parse(event.data) as SignalData).catch(() => undefined);
        } catch {
          // Malformed signaling is ignored.
        }
      }
    });
  }, [subscribeEphemeral, callPeer, closePeer, handleSignal]);

  const leave = useCallback(() => {
    if (!joinedRef.current) return;
    joinedRef.current = false;
    sendRef.current({ kind: "voice", on: false });
    for (const userId of [...peersRef.current.keys()]) closePeer(userId);
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    analysersRef.current.clear();
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    setJoined(false);
    setMuted(false);
    setSpeaking(new Set());
  }, [closePeer]);

  const join = useCallback(async () => {
    if (joinedRef.current) return;
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      setError("Voice chat isn't supported in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      localStreamRef.current = stream;
      joinedRef.current = true;
      setJoined(true);
      watchLevel("__me__", stream);
      sendRef.current({ kind: "voice", on: true });

      const me = currentUserIdRef.current;
      for (const userId of participantsRef.current.keys()) {
        if (me && me > userId) void callPeer(userId).catch(() => undefined);
      }
    } catch {
      setError("Microphone access was blocked. Allow it in your browser to join voice.");
    }
  }, [callPeer, watchLevel]);

  const toggleMute = useCallback(() => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMuted(!track.enabled);
  }, []);

  // Speaking indicators.
  useEffect(() => {
    if (!joined) return;
    const buffer = new Uint8Array(256);
    const timer = window.setInterval(() => {
      const active = new Set<string>();
      for (const [key, analyser] of analysersRef.current) {
        analyser.getByteTimeDomainData(buffer);
        let sum = 0;
        for (const value of buffer) {
          const centred = (value - 128) / 128;
          sum += centred * centred;
        }
        if (Math.sqrt(sum / buffer.length) > SPEAKING_THRESHOLD) {
          active.add(key === "__me__" ? (currentUserIdRef.current ?? key) : key);
        }
      }
      setSpeaking((previous) => {
        if (previous.size === active.size && [...active].every((id) => previous.has(id))) return previous;
        return active;
      });
    }, SPEAKING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [joined]);

  // Leave when the component unmounts (navigating away).
  useEffect(() => leave, [leave]);

  return { joined, muted, error, participants, speaking, join, leave, toggleMute };
}
