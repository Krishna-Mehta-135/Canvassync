FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.30.1 --activate
WORKDIR /app

FROM base AS pruner
RUN pnpm add -g turbo
COPY . .
RUN turbo prune web --docker

FROM base AS builder
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
ENV NEXT_PUBLIC_API_URL=http://localhost:13001/api/v1
ENV NEXT_PUBLIC_WS_URL=ws://localhost:18081
RUN pnpm turbo run build --filter=web...

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app ./
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 appuser && chown -R appuser:nodejs /app
USER appuser
EXPOSE 3000
CMD ["pnpm", "--filter", "web", "start"]
