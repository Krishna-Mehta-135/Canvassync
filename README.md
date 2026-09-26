<div align="center">
    <img src="./apps/web/public/logo-canvasio.svg" alt="Canvas.io Logo" width="112" />
    <h1>Canvas.io</h1>
    <p><strong>Realtime Collaborative Whiteboard Platform</strong></p>
</div>

![Node >=18](https://img.shields.io/badge/node-%3E%3D18-339933?logo=nodedotjs&logoColor=white)
![pnpm 10](https://img.shields.io/badge/pnpm-10-F69220?logo=pnpm&logoColor=white)
![Turborepo](https://img.shields.io/badge/turbo-monorepo-EF4444?logo=turborepo&logoColor=white)
![Next.js 16](https://img.shields.io/badge/next.js-16-000000?logo=nextdotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/typescript-5.9-3178C6?logo=typescript&logoColor=white)
![Prisma](https://img.shields.io/badge/prisma-ORM-2D3748?logo=prisma&logoColor=white)

**Canvas.io** is a lightning-fast, real-time collaborative whiteboard engineered for modern teams. Built as a high-performance Turborepo monorepo, it seamlessly combines a stunning Next.js frontend, an Express API, a robust WebSocket synchronization backend, and an intelligent AI generation worker. It leverages shared internal packages for crisp canvas rendering, protocol contracts, and highly durable transport primitives to ensure your ideas are never lost.

## Two Reading Paths

- Product overview: start with [Product Snapshot](#product-snapshot)
- Engineering reference:
  - [Architectural Overview](docs/architecture-overview.md)
  - [API Reference](docs/api-reference.md)
  - [Developer Guide](docs/developer-guide.md)
  - [Codebase Walkthrough](docs/codebase-walkthrough.md)
  - [Feature Guide](docs/features.md)
  - **Conceptual Deep Dives:**
    - [Core Concepts (State, Shapes, Rooms)](docs/core-concepts.md)
    - [Persistence Layer (Storage, Soft Delete, Recovery)](docs/persistence-layer.md)
    - [Real-time Synchronization (Intent & Trade-offs)](docs/architecture-realtime-sync.md)
    - [Canvas Engine Performance (Why we decoupled React)](docs/architecture-canvas-engine.md)
    - [Database Resilience Strategy (Circuit Breakers & Retries)](docs/architecture-db-resilience.md)
    - [Asynchronous AI Pipeline (Why we use queues)](docs/architecture-ai-pipeline.md)
    - [Security, Auth & Multi-tenancy (Defensive Layering)](docs/architecture-security-model.md)
    - [Monorepo & Shared Package Strategy](docs/architecture-monorepo-strategy.md)
  - [Scaling & Performance](docs/scaling-runbook.md)

## Table of Contents

- [Product Snapshot](#product-snapshot)
- [Platform Overview](#platform-overview)
- [Architecture](#architecture)
- [Realtime Sync Model](#realtime-sync-model)
- [AI Generation Pipeline](#ai-generation-pipeline)
- [Monorepo Structure](#monorepo-structure)
- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [API Surface](#api-surface)
- [Scripts](#scripts)
- [Observability and Scaling](#observability-and-scaling)
- [Troubleshooting](#troubleshooting)

## Product Snapshot

Canvas.io is crafted for visionary teams that demand live, structured visual collaboration without sacrificing technical depth, speed, or aesthetics. Whether you're brainstorming, wireframing, or mapping out complex architectures, Canvas.io provides the infinite space you need.

### What it solves

- Real-time ideation and diagramming in shared rooms
- Fast collaborative editing with low-latency sync
- AI-assisted diagram generation from natural-language prompts
- Persistent room history backed by durable infrastructure

### Core user capabilities

- Multi-user collaborative canvas with room-based access
- Invite links and owner-managed access requests
- Group chat, direct messages, and shape-linked comments
- Export-ready canvas workflows in the web app
- Live cursors, cursor chat, reactions, follow/present mode and a shared timer
- Version history with time-travel restore and timelapse video export
- AI: generate diagrams, edit a selection in place, summarize a board, turn a photo into shapes
- Mermaid import/export, tidy auto-layout, sketch clean-up, templates, align/distribute, minimap
- Editor / view-only roles and read-only public share links

See the [Feature Guide](docs/features.md) for details.

### Why this architecture matters

- Reliable under scale: Redis authority plus RabbitMQ durability
- Safer operations: bounded retries and circuit breaker behavior for DB access
- Faster iteration: monorepo shared packages for protocol, rendering, and transport

## Platform Overview

Canvas.io is designed around room-based collaboration with low-latency synchronization and durable event delivery:

- Real-time multi-user canvas updates over WebSocket
- Redis-authoritative room versions and latest snapshots
- RabbitMQ durable room events for replay and reliability
- Prisma + PostgreSQL persistence for users, rooms, shapes, and chat
- AI-assisted diagram generation through async worker jobs
- Shared monorepo packages for protocol, canvas logic, and infrastructure contracts

## Architecture

```mermaid
flowchart LR
    subgraph Client Layer
        B[Browser Client]
    end

    subgraph App Layer
        WEB[apps/web\nNext.js App Router]
        HTTP[apps/http-backend\nExpress REST API]
        WS[apps/ws-backend\nWebSocket Sync Server]
        AIW[apps/ai-worker\nGemini Worker]
    end

    subgraph Data and Messaging Layer
        PG[(PostgreSQL)]
        REDIS[(Redis)]
        RMQ[(RabbitMQ)]
    end

    subgraph Shared Packages
        CE[packages/canvas-engine]
        COMMON[packages/common]
        RS[packages/redis-sync]
        QS[packages/queue-sync]
        DBPKG[packages/db]
        BC[packages/backend-common]
    end

    B -->|HTTP| WEB
    WEB -->|REST| HTTP
    WEB -->|WS Events| WS

    HTTP -->|Prisma via @repo/db| PG
    WS -->|Prisma via @repo/db| PG

    WS -->|authoritative version and snapshot| REDIS
    WS -->|durable room events and persist jobs| RMQ

    HTTP -->|publish AI job| RMQ
    RMQ -->|consume AI job| AIW
    AIW -->|internal callback /internal/ai/result| HTTP

    WEB --> CE
    WEB --> COMMON
    HTTP --> COMMON
    WS --> COMMON
    WS --> RS
    HTTP --> QS
    WS --> QS
    AIW --> QS
    HTTP --> BC
    WS --> BC
    AIW --> BC
    DBPKG --> PG
```

## Realtime Sync Model

Redis remains the authoritative source for room version and latest snapshot. RabbitMQ provides durable fan-out and replay; Redis Pub/Sub remains a low-latency fallback path.

```mermaid
sequenceDiagram
    participant C as Canvas Client
    participant W as WS Backend Node
    participant R as Redis
    participant Q as RabbitMQ
    participant N as Peer WS Node

    C->>W: canvas_snapshot(roomId, version, shapes, actionId)
    W->>R: atomic compare-and-commit version+snapshot

    alt version mismatch
        W-->>C: sync_error + authoritative snapshot
    else committed
        W->>Q: publish durable room event
        W->>R: publish fallback pub/sub event
        Q-->>N: consume durable room event
        R-->>N: receive fallback pub/sub event
        N->>N: actionId dedupe + monotonic version guard
        N-->>C: canvas_snapshot_broadcast
    end
```

## AI Generation Pipeline

AI generation is asynchronous and queue-backed so user requests do not block HTTP request threads.

```mermaid
sequenceDiagram
    participant U as User (Web)
    participant API as HTTP Backend
    participant MQ as RabbitMQ
    participant AW as AI Worker
    participant G as Gemini API

    U->>API: POST /room/:roomId/ai/generate
    API->>API: validate auth, room access, prompt
    API->>MQ: publish AI generate job
    API-->>U: 202 Accepted + jobId

    MQ-->>AW: consume job
    AW->>G: generate shapes JSON
    G-->>AW: model output
    AW->>API: POST /internal/ai/result (x-internal-secret)

    loop polling
        U->>API: GET /room/:roomId/ai/generate/:jobId
        API-->>U: pending | done | error
    end
```

## Monorepo Structure

### Applications

| Path                | Purpose                                                                  |
| ------------------- | ------------------------------------------------------------------------ |
| `apps/web`          | Next.js frontend (auth, rooms, canvas UI, AI prompt bar, exports)        |
| `apps/http-backend` | Express API (auth, room lifecycle, access control, AI job orchestration) |
| `apps/ws-backend`   | WebSocket backend (presence, snapshot sync, cross-node fan-out)          |
| `apps/ai-worker`    | Queue consumer that calls Gemini and returns generated shapes            |

### Core Packages

| Path                         | Purpose                                                      |
| ---------------------------- | ------------------------------------------------------------ |
| `packages/canvas-engine`     | Shared rendering, geometry, text layout, interaction logic   |
| `packages/common`            | Shared zod schemas, API payload contracts, ws protocol types |
| `packages/db`                | Prisma schema, generated client, migrations, docker-compose  |
| `packages/redis-sync`        | Redis room version/snapshot primitives and pub/sub sync      |
| `packages/queue-sync`        | RabbitMQ durable event and job primitives                    |
| `packages/backend-common`    | Shared backend config and environment loading                |
| `packages/ui`                | Shared UI components                                         |
| `packages/eslint-config`     | Shared lint presets                                          |
| `packages/typescript-config` | Shared TypeScript base configs                               |

## Quick Start

### 1. Prerequisites

- Node.js 18+
- pnpm 10+
- Docker Desktop (for PostgreSQL, Redis, RabbitMQ)

### 2. Install dependencies

```bash
pnpm install
```

### 3. Start local infrastructure

```bash
pnpm db:up
```

This starts:

- PostgreSQL: `localhost:5432`
- Redis: `localhost:6379`
- RabbitMQ: `localhost:5672`
- RabbitMQ management UI: `http://localhost:15672`

### 4. Configure environment

Use the root env template as the single source of truth for all backend services.

```bash
cp .env.example .env
```

Then edit `.env` values for your local machine (JWT secret, database URL, Gmail app password, Gemini key, and similar secrets).

```env
# Core
JWT_SECRET=replace-with-a-long-random-secret
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/canvas
PORT=3001
REDIS_URL=redis://127.0.0.1:6379
RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5672

# Internal worker callback security
INTERNAL_SECRET=replace-with-a-random-internal-secret
HTTP_BACKEND_INTERNAL_URL=http://127.0.0.1:3001

# AI provider
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL_CANDIDATES=gemini-flash-latest,gemini-flash-lite-latest

# Web app URL for email flows
WEB_APP_URL=http://localhost:3000

# Password reset email
GMAIL_USER=your-email@gmail.com
GMAIL_APP_PASSWORD=your-google-app-password
GMAIL_FROM_EMAIL=Canvas.io <your-email@gmail.com>
```

### 5. Generate Prisma client and apply migrations

```bash
pnpm --filter @repo/db db:generate
pnpm --filter @repo/db db:migrate
```

### 6. Run the workspace

```bash
pnpm dev
```

Default local endpoints:

- Web app: `http://localhost:3000`
- HTTP API base: `http://localhost:3001/api/v1`
- WebSocket backend: `ws://localhost:8080`

### Optional: run services individually

```bash
pnpm --filter web dev
pnpm --filter http-backend dev
pnpm --filter ws-backend dev
pnpm --filter ai-worker dev
```

## Environment Variables

Source of truth: `.env.example` at repository root. Keep `.env.example` aligned with any new runtime variable.

### Required

| Variable          | Used By                                              | Description                              |
| ----------------- | ---------------------------------------------------- | ---------------------------------------- |
| `JWT_SECRET`      | http-backend, ws-backend, ai-worker config bootstrap | JWT signing and verification secret      |
| `DATABASE_URL`    | db package and both backends                         | PostgreSQL connection string             |
| `PORT`            | http-backend                                         | HTTP server port                         |
| `REDIS_URL`       | ws-backend                                           | Redis authority for room sync            |
| `RABBITMQ_URL`    | http-backend, ws-backend, ai-worker                  | Durable queue/event transport            |
| `INTERNAL_SECRET` | http-backend, ai-worker                              | Secret for internal AI callback endpoint |
| `GEMINI_API_KEY`  | ai-worker                                            | Gemini API authentication                |

### Auth and Email

| Variable             | Default                    | Purpose                                               |
| -------------------- | -------------------------- | ----------------------------------------------------- |
| `WEB_APP_URL`        | `http://localhost:3000`    | Base URL used in auth emails and password reset links |
| `GMAIL_USER`         | none                       | SMTP sender account                                   |
| `GMAIL_APP_PASSWORD` | none                       | Gmail app password used by mail transport             |
| `GMAIL_FROM_EMAIL`   | falls back to `GMAIL_USER` | Sender label/email for outgoing auth emails           |

### HTTP and DB resilience

| Variable                                 | Default | Purpose                                       |
| ---------------------------------------- | ------- | --------------------------------------------- |
| `HTTP_RATE_LIMIT_WINDOW_MS`              | `60000` | HTTP rate-limit window                        |
| `HTTP_RATE_LIMIT_MAX_REQUESTS`           | `120`   | HTTP requests allowed per window              |
| `DB_RETRY_ATTEMPTS`                      | `3`     | Transient DB retry attempts                   |
| `DB_RETRY_BASE_DELAY_MS`                 | `75`    | Base delay for exponential backoff            |
| `DB_CIRCUIT_BREAKER_ENABLED`             | `true`  | Enable fail-fast circuit breaker for DB calls |
| `DB_CIRCUIT_FAILURE_THRESHOLD`           | `5`     | Failures in window before opening breaker     |
| `DB_CIRCUIT_WINDOW_MS`                   | `60000` | Sliding failure window                        |
| `DB_CIRCUIT_OPEN_MS`                     | `30000` | Cooldown while circuit is open                |
| `DB_CIRCUIT_HALF_OPEN_SUCCESS_THRESHOLD` | `2`     | Probe successes required to close circuit     |

### Queue and sync tuning

| Variable                            | Default                    | Purpose                        |
| ----------------------------------- | -------------------------- | ------------------------------ |
| `RABBITMQ_ROOM_EVENTS_EXCHANGE`     | `canvas.room.events`       | Durable room event exchange    |
| `RABBITMQ_ROOM_EVENTS_QUEUE_PREFIX` | `canvas.room.events.node`  | Per-node durable queue prefix  |
| `RABBITMQ_ROOM_EVENTS_PARTITIONS`   | `16`                       | Room routing partitions        |
| `RABBITMQ_PREFETCH`                 | `200`                      | Consumer backpressure tuning   |
| `RABBITMQ_DB_PERSIST_EXCHANGE`      | `canvas.room.persist`      | Persist job exchange           |
| `RABBITMQ_DB_PERSIST_QUEUE`         | `canvas.room.persist.jobs` | Persist job queue              |
| `RABBITMQ_DB_PERSIST_ROUTING_KEY`   | `room.persist`             | Persist job routing key        |
| `RABBITMQ_AI_GENERATE_EXCHANGE`     | `canvas.ai.generate`       | AI generation exchange         |
| `RABBITMQ_AI_GENERATE_QUEUE`        | `canvas.ai.generate.jobs`  | AI generation queue            |
| `RABBITMQ_AI_GENERATE_ROUTING_KEY`  | `ai.generate`              | AI generation routing key      |
| `WS_MAX_MESSAGE_BYTES`              | `524288`                   | Max accepted websocket payload |
| `WS_SNAPSHOT_RATE_LIMIT_COUNT`      | `30`                       | Snapshot rate-limit count      |
| `WS_SNAPSHOT_RATE_LIMIT_WINDOW_MS`  | `1000`                     | Snapshot rate-limit window     |
| `WS_METRICS_LOG_INTERVAL_MS`        | `30000`                    | WS metrics logging interval    |

## API Surface

Base URL: `http://localhost:3001/api/v1`

### Auth

- `POST /auth/signup`
- `POST /auth/signin`
- `GET /auth/current-user`
- `POST /auth/refresh-token`
- `POST /auth/logout`
- `POST /auth/forgot-password`
- `POST /auth/reset-password`

### Room and collaboration

- `POST /room` create room
- `GET /room/mine` list owned rooms
- `GET /room/:roomId/shapes` paginated shapes (optional viewport filter)
- `PUT /room/:roomId/shapes` replace full snapshot (owner-only)
- `GET /room/:roomId/chat/bootstrap` initial chat payload (group, direct, comment)
- `GET /room/:roomId/invite` generate invite link
- `POST /room/access/request` request member access
- `GET /room/access/requests/incoming` list owner inbox
- `POST /room/access/requests/decision` approve or reject

### AI endpoints

- `POST /room/:roomId/ai/generate` enqueue AI diagram generation
- `GET /room/:roomId/ai/generate/:jobId` get AI generation status
- `POST /internal/ai/result` internal worker callback (guarded by `x-internal-secret`)

## Scripts

### Root scripts

| Command            | Description                               |
| ------------------ | ----------------------------------------- |
| `pnpm dev`         | Run workspace dev tasks through Turborepo |
| `pnpm build`       | Build all apps/packages                   |
| `pnpm lint`        | Run lint tasks                            |
| `pnpm check-types` | Run TypeScript checks                     |
| `pnpm format`      | Format `.ts`, `.tsx`, `.md` files         |
| `pnpm db:up`       | Start PostgreSQL, Redis, RabbitMQ         |
| `pnpm db:down`     | Stop local infra                          |
| `pnpm db:logs`     | Tail infra logs                           |

### Database package scripts

| Command                              | Description                         |
| ------------------------------------ | ----------------------------------- |
| `pnpm --filter @repo/db db:generate` | Generate Prisma client              |
| `pnpm --filter @repo/db db:migrate`  | Create/apply migrations             |
| `pnpm --filter @repo/db db:push`     | Push schema without migration files |

## Observability and Scaling

Operational documentation:

- Realtime scale SLOs and load testing: [docs/scaling-runbook.md](docs/scaling-runbook.md)
- Redis and RabbitMQ sync architecture: [docs/ws-redis-sync-architecture.md](docs/ws-redis-sync-architecture.md)
- Database retry and circuit breaker model: [docs/db-resilience.md](docs/db-resilience.md)

## Troubleshooting

- If API calls fail, verify HTTP backend is running on port `3001`.
- If realtime updates do not propagate, validate both `REDIS_URL` and `RABBITMQ_URL` connectivity.
- If AI jobs remain pending, ensure `apps/ai-worker` is running and `GEMINI_API_KEY` is valid.
- If shapes fail to persist, run Prisma migrations and confirm PostgreSQL is healthy.
- If password reset emails are not delivered, verify Gmail app-password configuration.
- If collaborators joining causes frame drops or `Maximum update depth exceeded`, update to latest sync hooks and verify no custom `useEffect` calls are setting state from unstable array/object dependencies.
