# ── build: compile better-sqlite3 if no prebuilt binary matches this platform ──
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ── runtime ──
FROM node:22-bookworm-slim
WORKDIR /app
# git is required at runtime: the app pulls config/*.yml from the repo itself so
# YAML edits go live without a redeploy.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system --add safe.directory '*'

COPY --from=build /app/node_modules ./node_modules
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
COPY tools ./tools

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data \
    CONFIG_DIR=/repo/config \
    REPO_DIR=/repo

EXPOSE 8080
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
