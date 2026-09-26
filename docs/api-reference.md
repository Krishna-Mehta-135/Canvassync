# API Reference

This document provides a detailed reference for the REST and WebSocket APIs used in Canvas.io.

## REST API

**Base URL:** `http://localhost:3001/api/v1`

### Authentication (`/auth`)

| Endpoint           | Method | Auth | Description                                                          |
| :----------------- | :----- | :--- | :------------------------------------------------------------------- |
| `/signup`          | POST   | None | Create a new account. Sets `accessToken` and `refreshToken` cookies. |
| `/signin`          | POST   | None | Sign in to an existing account. Sets auth cookies.                   |
| `/current-user`    | GET    | JWT  | Returns the current user's profile information.                      |
| `/refresh-token`   | POST   | None | Refreshes the `accessToken` using the `refreshToken` cookie.         |
| `/logout`          | POST   | JWT  | Invalidates the current session and clears cookies.                  |
| `/forgot-password` | POST   | None | Sends a password reset email.                                        |
| `/reset-password`  | POST   | None | Completes the password reset process using a reset token.            |

### Room & Collaboration (`/room`)

| Endpoint                     | Method | Auth | Description                                             |
| :--------------------------- | :----- | :--- | :------------------------------------------------------ |
| `/`                          | POST   | JWT  | Create a new collaboration room.                        |
| `/mine`                      | GET    | JWT  | List all rooms owned by the current user.               |
| `/:roomId/chat/bootstrap`    | GET    | JWT  | Returns initial chat messages (Group, Direct, Comment). |
| `/:roomId/shapes`            | GET    | JWT  | Returns the current list of shapes for a room.          |
| `/:roomId/shapes`            | PUT    | JWT  | Replaces the full canvas snapshot (owner or editor; not viewers). |
| `/room/slug/:slug`           | GET    | JWT  | Resolves a room ID from its slug.                       |
| `/resolve/:userHandle/:slug` | GET    | JWT  | Resolves a room by owner handle and slug.               |
| `/:roomId/slug`              | PATCH  | JWT  | Renames a room's slug.                                  |
| `/:roomId/invite`            | GET    | JWT  | Generates or retrieves an invite link for the room.     |
| `/access/request`            | POST   | JWT  | Request access to a private room.                       |
| `/access/requests/incoming`  | GET    | JWT  | List incoming access requests for the owner.            |
| `/access/requests/decision`  | POST   | JWT  | Approve or reject an access request. Optional `role` (`EDITOR` default, or `VIEWER`) is granted on approval. |
| `/:roomId/members`           | GET    | JWT  | Owner: list people with access and their roles.         |
| `/:roomId/members/:userId`   | PATCH  | JWT  | Owner: set a member's role (`{ "role": "EDITOR" \| "VIEWER" }`). |
| `/:roomId/members/:userId`   | DELETE | JWT  | Owner: remove someone's access.                         |
| `/:roomId/history`           | GET    | JWT  | Version history: recent snapshots (`id`, `shapeCount`, `createdAt`), newest first. |
| `/:roomId/history/:snapshotId` | GET  | JWT  | One history snapshot including its `shapes`.            |
| `/:roomId/public`            | GET    | JWT  | Owner: is the public view link enabled? Returns `token`. |
| `/:roomId/public`            | POST   | JWT  | Owner: enable the public link (`{ "rotate": true }` issues a new token). |
| `/:roomId/public`            | DELETE | JWT  | Owner: revoke the public link.                          |

### AI Generation

| Endpoint                      | Method | Auth | Description                                   |
| :---------------------------- | :----- | :--- | :-------------------------------------------- |
| `/:roomId/ai/generate`        | POST   | JWT  | Enqueues a new AI diagram generation job.     |
| `/:roomId/ai/generate/:jobId` | GET    | JWT  | Polls for the status of an AI generation job. |

`POST /:roomId/ai/generate` accepts an optional `mode`:

| `mode`      | Extra body fields            | Result                                                                                       |
| :---------- | :--------------------------- | :------------------------------------------------------------------------------------------- |
| _(omitted)_ / `generate` | –               | New shapes for the prompt.                                                                   |
| `edit`      | `selection` (1–120 shapes)   | Rewritten version of the selection (same id = modified, new id = added, missing = deleted).  |
| `summarize` | `selection` (board shapes)   | `summary`: markdown with a summary, key points and action items (the `shapes` list is empty).|
| `image`     | `image` `{ mimeType, data }` | Shapes recreated from a downscaled base64 image (JPEG/PNG/WebP, ≤ ~1.4 MB base64).           |

The job status response contains `status`, `shapes`, `summary` and `errorMessage`.

### Public (no auth)

| Endpoint              | Method | Auth  | Description                                                                                       |
| :-------------------- | :----- | :---- | :------------------------------------------------------------------------------------------------ |
| `/public/board/:token` | GET   | Token | Read-only board for a public link: `{ room: { slug, ownerName, ownerHandle }, shapes }`. 404 when the token is unknown or revoked. |

### Internal Endpoints

| Endpoint              | Method | Auth   | Description                                                                                    |
| :-------------------- | :----- | :----- | :--------------------------------------------------------------------------------------------- |
| `/internal/ai/result` | POST   | Secret | Callback for the AI worker to submit generated results. Guarded by `x-internal-secret` header. |

---

## WebSocket API

The WebSocket server handles real-time synchronization of canvas state, presence, and chat.

**Endpoint:** `ws://localhost:8080`

### Connection & Lifecycle

1.  **Handshake:** Clients connect via standard WebSocket. Authentication is usually handled via cookies or a query parameter (implementation dependent).
2.  **Joining a Room:**
    - **Client Sends:** `{ "type": "join_room", "roomId": 123 }`
    - **Server Responds:** `room_joined` payload containing current `version`, `shapes`, and current `presences`.

### Canvas Synchronization

Canvas state is synchronized using full snapshots and monotonic versioning.

| Message Type                | Direction        | Description                                                                             |
| :-------------------------- | :--------------- | :-------------------------------------------------------------------------------------- |
| `canvas_snapshot`           | Client -> Server | Sends a full snapshot of the canvas with a target version.                              |
| `canvas_snapshot_broadcast` | Server -> Client | Broadcasts a new snapshot to all peers in the room. Includes `senderId` and `actionId`. |
| `canvas_snapshot_ack`       | Server -> Client | Acknowledges a successful snapshot commit.                                              |
| `sync_error`                | Server -> Client | Sent when a snapshot is rejected (e.g., version mismatch).                              |

### Presence

Presence updates are frequent and transient.

| Message Type          | Direction        | Description                                                         |
| :-------------------- | :--------------- | :------------------------------------------------------------------ |
| `update_presence`     | Client -> Server | Updates the user's cursor position, selected IDs, and current tool. |
| `room_presence_state` | Server -> Client | Broadcasts the full presence state of all users in the room.        |

### Ephemeral events (cursors, reactions, timer, follow mode)

Short-lived, never persisted, relayed to other nodes over the Redis presence channel and rate limited per socket (`WS_EPHEMERAL_RATE_LIMIT_COUNT`, default 60/s; excess is dropped silently).

| Message Type          | Direction        | Description                                                                 |
| :-------------------- | :--------------- | :-------------------------------------------------------------------------- |
| `ephemeral`           | Client -> Server | `{ roomId, event }` where `event.kind` is `cursor`, `cursor_chat`, `reaction`, `viewport` or `timer`. |
| `ephemeral_broadcast` | Server -> Client | Same `event`, plus `senderId` and `senderName`.                             |

- `viewport` events carry the canvas point at the centre of the sender's screen plus scale, so followers with different screen sizes land on the same content. `present: true` makes everyone auto-follow the sender.
- `timer` carries `remainingMs` (not a deadline, so client clocks needn't agree; `null` cancels). Only owners/editors may start one. The server remembers the deadline and replays the remaining time to late joiners.

### Roles

`room_joined` includes `role` (`OWNER`, `EDITOR` or `VIEWER`). The server rejects `canvas_snapshot` from viewers with `sync_error: "Read-only: …"`; the role is re-read from the database every 10 seconds so demotions apply to connected users. Viewers can still follow, chat and comment.

### Chat

| Message Type           | Direction        | Description                                              |
| :--------------------- | :--------------- | :------------------------------------------------------- |
| `send_chat_message`    | Client -> Server | Sends a message (Kind: `group`, `direct`, or `comment`). |
| `chat_message_created` | Server -> Client | Broadcasts a new message to relevant recipients.         |

### Safety & Reliability

- **`actionId`:** Every snapshot broadcast includes a unique `actionId` to prevent duplicate processing on peer nodes.
- **Version Guard:** Clients and servers ignore snapshots with versions lower than their current local state.
- **Heartbeat:** Standard `ping`/`pong` mechanism to detect disconnected clients.
