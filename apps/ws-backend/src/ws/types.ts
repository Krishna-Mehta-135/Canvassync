import { WebSocket } from "ws";
import { JwtPayload } from "jsonwebtoken";

export interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
  userName?: string;
  currentRoomId?: number;
  /** Role in the current room, re-checked periodically so demotions apply quickly. */
  role?: "OWNER" | "EDITOR" | "VIEWER";
  roleCheckedAtMs?: number;
}

export interface MyJwtPayload extends JwtPayload {
  userId: string;
  name?: string;
  tokenVersion?: number;
  type?: "access" | "refresh" | "ws-handshake";
}
