# --- build ---
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- runtime ---
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    CODEX_HOME=/data/codex \
    REPOS_CACHE_DIR=/data/repos
# git — для клонов/worktree; codex + claude — CLI-агенты (обе под подпиской).
# bubblewrap — то, чем codex РЕАЛЬНО делает песочницу на Linux. Без него он ругается
# «could not find bubblewrap on PATH», падает на встроенный fallback, и sandbox
# workspace-write не даёт записи даже в собственный workspace (проверено).
# curl — для диагностики сети из контейнера.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates bubblewrap curl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev \
    && npm install -g @openai/codex@0.166.0 @anthropic-ai/claude-code \
    && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /data/codex /data/repos
EXPOSE 8080
CMD ["node", "dist/server.js"]
