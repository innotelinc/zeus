# ═══════════════════════════════════════════════════════════════
# Innotel PBX Portal — Dockerfile
# ═══════════════════════════════════════════════════════════════
# Build:  docker build -t innotel/pbx-portal .
# Run:    docker run -p 3000:3000 -v pbx-data:/app/data --env-file .env innotel/pbx-portal
# ═══════════════════════════════════════════════════════════════

FROM node:22-alpine AS base
WORKDIR /app

# ─── Stage 1: Install dependencies ───────────────────────────
FROM base AS deps
RUN apk add --no-cache python3 make g++ sqlite-dev

COPY package.json package-lock.json ./
# patches/ must exist before npm ci so the postinstall (patch-package) can
# apply the Next.js workaround for the error-page prerender bug.
COPY patches ./patches
RUN npm ci

# ─── Stage 2: Build the application ──────────────────────────
FROM base AS builder
RUN apk add --no-cache python3 make g++ sqlite-dev

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Bust Turbopack/Next.js cache — changes to this line invalidate the build layer.
# Increment the counter below if source changes are not being picked up.
RUN echo "build-cache-buster: v5"

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Remove devDependencies from the standalone output
RUN cd .next/standalone && npm prune --omit=dev

# ─── Stage 3: Production runner ──────────────────────────────
# The entrypoint runs as root so it can chown the (possibly stale,
# root-owned) data volume on start, then drops privileges to the
# nextjs user via su-exec before running the app.
FROM node:22-alpine AS runner
RUN apk add --no-cache sqlite-dev curl su-exec

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# Copy standalone output from builder
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy scripts for seeding and migrations
COPY --from=builder /app/scripts ./scripts

# Copy entrypoint
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Create data directory for SQLite (persistent volume mount point)
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data /app/scripts

EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
