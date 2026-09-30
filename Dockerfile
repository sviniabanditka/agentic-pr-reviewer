FROM oven/bun:1-debian

# gh: GitHub access. Its apt repo is the install path the gh project documents.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
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

EXPOSE 8080
CMD ["bun", "src/main.ts"]
