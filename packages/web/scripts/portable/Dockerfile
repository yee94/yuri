FROM node:24-bookworm AS build
ARG YURI_OPENCODE2_VERSION
ENV YURI_OPENCODE2_VERSION=$YURI_OPENCODE2_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g bun@1.3.14
WORKDIR /source
COPY . .
RUN bun install --frozen-lockfile
RUN bun run build:web
RUN npm rebuild better-sqlite3 --foreground-scripts \
    && pty_dir="$(node -p 'require("node:path").dirname(require.resolve("node-pty/package.json"))')" \
    && npm --prefix "$pty_dir" run install \
    && npm --prefix "$pty_dir" run postinstall
RUN bun run pack:portable -- /out

FROM debian:bookworm-slim AS verify
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out /artifacts
COPY packages/web/scripts/portable/smoke.mjs /smoke.mjs
RUN tar -xzf /artifacts/yuri-*.tar.gz -C /opt \
    && mv /opt/yuri /opt/portable-host \
    && ! command -v node && ! command -v npm && ! command -v python3 && ! command -v g++ \
    && LD_LIBRARY_PATH=/opt/portable-host/runtime/lib /opt/portable-host/runtime/node /opt/portable-host/verify.mjs \
    && LD_LIBRARY_PATH=/opt/portable-host/runtime/lib /opt/portable-host/runtime/node /smoke.mjs /opt/portable-host

FROM scratch AS artifacts
COPY --from=verify /artifacts /
