# ═══════════════════════════════════════════════════════════════
# Innotel PBX Portal — Dockerfile
# ═══════════════════════════════════════════════════════════════
# Build:  docker build -t innotel/pbx-portal .
# Run:    docker run -p 3000:3000 -v pbx-data:/app/data --env-file .env innotel/pbx-portal
# ═══════════════════════════════════════════════════════════════

FROM node:20-alpine AS base
WORKDIR /app

# ─── Stage 1: Install dependencies ───────────────────────────
FROM base AS deps
RUN apk add --no-cache python3 make g++ sqlite-dev

COPY package.json package-lock.json ./
RUN npm ci

# ─── Stage 2: Build the application ──────────────────────────
FROM base AS builder
RUN apk add --no-cache python3 make g++ sqlite-dev

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Remove devDependencies from the standalone output
RUN cd .next/standalone && npm prune --omit=dev

# ─── Stage 3: Production runner ──────────────────────────────
FROM node:20-alpine AS runner
RUN apk add --no-cache sqlite-dev curl

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

USER nextjs

EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
