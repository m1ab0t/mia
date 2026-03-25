# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:22-slim AS builder

# Native modules (better-sqlite3, hyperdb/rocksdb) need build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ libatomic1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (layer caching)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY src/ src/
COPY scripts/build.mjs scripts/build.mjs
COPY tsconfig.json ./
RUN npm run build

# Strip dev dependencies
RUN npm prune --production

# ── Stage 2: Runtime ───────────────────────────────────────────────────────
FROM node:22-slim

# libatomic1: required by better-sqlite3 on some architectures
# tini: PID 1 init — reaps zombie children (p2p-agent, plugin CLIs)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libatomic1 tini \
  && rm -rf /var/lib/apt/lists/*

# Non-root user — reuse the existing node user (UID/GID 1000) from the base image
RUN usermod -l mia -d /home/mia -m node \
  && groupmod -n mia node

WORKDIR /app

COPY --from=builder --chown=mia:mia /app/dist/ dist/
COPY --from=builder --chown=mia:mia /app/node_modules/ node_modules/
COPY --from=builder --chown=mia:mia /app/package.json ./

# Entrypoint script bridges Docker env vars → MIA .env files
COPY --chown=mia:mia docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Persistent data: config, memory.db, chat-history, P2P seed, scheduler tasks
RUN mkdir -p /home/mia/.mia && chown mia:mia /home/mia/.mia
VOLUME /home/mia/.mia

USER mia

# Health check: verify daemon PID file exists and process is alive
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD test -f /home/mia/.mia/daemon.pid && kill -0 $(cat /home/mia/.mia/daemon.pid) || exit 1

ENTRYPOINT ["tini", "--", "/entrypoint.sh"]
CMD ["node", "dist/daemon.js"]
