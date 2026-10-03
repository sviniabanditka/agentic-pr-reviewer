# ── web: build the SPA ──────────────────────────────────────────
FROM oven/bun:1-debian AS web
WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY web ./web
RUN bun run build:web

# ── runtime ─────────────────────────────────────────────────────
FROM oven/bun:1-debian
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

USER bun
# Claude Code: native build, unmodified, pinned by the image build date.
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH=/home/bun/.local/bin:$PATH \
    DISABLE_AUTOUPDATER=1 \
    DATA_DIR=/data \
    CONFIG_PATH=/config/config.json \
    PORT=8080

WORKDIR /app
COPY --chown=bun package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY --chown=bun src ./src
COPY --chown=bun --from=web /build/web/dist ./web/dist

EXPOSE 8080
CMD ["bun", "src/main.ts"]
