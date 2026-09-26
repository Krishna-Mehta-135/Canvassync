# Feature Guide

A tour of the collaboration, AI and diagramming features, where they live in the code, and the behaviour worth knowing about.

## Realtime collaboration

| Feature | What it does | Code |
| :-- | :-- | :-- |
| **Live cursors** | See collaborators' cursors with names, eased on a RAF loop (no React renders). | `apps/web/app/components/LiveCollabLayer.tsx` |
| **Cursor chat** | Press `/`, type, `Enter`. The message floats beside your cursor and fades. | same |
| **Reactions** | Emoji bar; reactions float up at your cursor on everyone's screen. | same |
| **Follow / Present** | Click a person to follow their view (any pan, click or `Esc` stops it). *Present* makes everyone follow you until you stop. | same + `ephemeral` `viewport` events |
| **Shared timer** | 1/3/5/10 minute countdown for the whole room with a chime; late joiners see the remaining time. | `LiveCollabLayer.tsx`, `apps/ws-backend/src/ws/connectionState.ts` |
| **Minimap** | Overview with the current view outlined; click/drag to jump. Toggle from the ⋯ menu. | `app/components/Minimap.tsx` |

All of the above ride on the `ephemeral` WebSocket message (see the API reference).

## Access & sharing

| Feature | Notes |
| :-- | :-- |
| **Editor / view-only roles** | Approve a request as *Can edit* or *View only*, or change it later in **People & roles**. Enforced server-side (WS + REST), mirrored client-side by `CanvasState.setReadOnly`. |
| **Public view link** | ⋯ → *Public view link…* creates an unguessable read-only URL `/view/<token>` (pan/zoom/fit, refreshes every 15 s). Rotate or turn off at any time. Exposes only room name, owner name and shapes. |

## Version history

⋯ → *Version history*. The WS server records a snapshot when canvas state is persisted (at most one per room per `HISTORY_MIN_INTERVAL_MS`, default 30 s; identical states are skipped; the newest `HISTORY_MAX_SNAPSHOTS_PER_ROOM`, default 60, are kept). The panel scrubs a timeline on an overlay canvas (live sync is untouched), plays a timelapse, **restores** a version (a normal undoable edit that syncs to everyone) and **exports a WebM video** of the whole history.

## AI

Runs through the same queue → worker → Gemini pipeline as generation (`docs/architecture-ai-pipeline.md`). Set `GEMINI_MODEL_CANDIDATES` to model **aliases** such as `gemini-flash-latest` — pinned versions get retired (e.g. `gemini-2.5-flash-lite` now returns 404 for new users).

- **Edit selection with AI** — select shapes → *Edit N selected with AI*. The result replaces the selection in one undoable step.
- **Summarize board** — key points and action items from the board's text; copy it or add it as a note.
- **Image → shapes** — upload a photo/screenshot; the browser downscales it to ≤ 1024 px and Gemini vision recreates nodes, connectors and labels.

## Diagramming

| Feature | Notes | Code |
| :-- | :-- | :-- |
| **Mermaid import** | Paste a flowchart (`[rect]`, `{decision}`, `((circle))`, `-->\|label\|`, `-.->`, `&`, chains). Laid out with a layered algorithm and bound connectors. | `packages/canvas-engine/src/diagram/mermaid.ts` |
| **Copy as Mermaid** | Exports nodes and bound connectors (selection, or the whole board). | same |
| **Tidy layout** | Re-arranges connected shapes top-down or left-right; moves labels, re-anchors connectors, leaves unconnected shapes alone. | `diagram/tidy.ts`, `diagram/layout.ts` |
| **Clean up sketch** | Snaps rough freehand strokes to rectangles, ellipses, diamonds, lines; strokes that start/end on shapes become bound arrows. | `diagram/sketch.ts` |
| **Templates & sticky notes** | Kanban, retro, SWOT, mind map, journey map, flowchart starter. | `diagram/templates.ts` |
| **Align / distribute** | Toolbar for 2+ selected shapes (3+ to distribute). | `diagram/arrange.ts` |
| **Smarter connector routing** | Bound connectors leave/enter perpendicular to the edge they are anchored to. Interior anchors keep the classic routing. | `packages/canvas-engine/src/connectors.ts` |

## Configuration added

| Variable | Default | Purpose |
| :-- | :-- | :-- |
| `WS_EPHEMERAL_RATE_LIMIT_COUNT` | `60` | Max ephemeral events per socket per second. |
| `HISTORY_MIN_INTERVAL_MS` | `30000` | Minimum time between history snapshots for a room. |
| `HISTORY_MAX_SNAPSHOTS_PER_ROOM` | `60` | Snapshots kept per room. |
| `GEMINI_MODEL_CANDIDATES` | `gemini-flash-latest,gemini-flash-lite-latest` | Comma-separated model aliases tried in order. |

## Database migrations added

`RoomSnapshot` (version history), `Room.publicToken` (public link) and `RoomMember.role` (roles). Deploys apply them with `prisma migrate deploy`.
