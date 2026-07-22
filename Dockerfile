# Combined application image: webapi + built webui SPA + static docs (+ bundled CLI).
# Components build in independent, cacheable stages — with BuildKit these run in
# parallel — then a slim runtime stage composes their artifacts (ADR 0023).
#
# This is the root app Dockerfile. Other images (base Bun runtime, Claude-Code
# runtime, CLI-utils, mirrored backing services, …) will get their own Dockerfiles
# (likely under dockerfiles/) as they're built — see docs/containers.md.

# ── deps: install dependencies once; shared by the build stages ─────────────
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock* bunfig.toml tsconfig.base.json ./
COPY packages ./packages
RUN bun install --frozen-lockfile || bun install

# ── build-webui: the React SPA → packages/webui/dist ────────────────────────
FROM deps AS build-webui
RUN bun run build

# ── build-docs: docs/*.md → self-contained static HTML (dependency-free) ────
FROM deps AS build-docs
COPY scripts ./scripts
COPY docs ./docs
COPY brand ./brand
RUN bun run scripts/build-docs.ts --out /docs-dist

# ── build-cli: compiled CLI binary (placeholder until the CLI is wired) ─────
# FROM deps AS build-cli
# RUN bun build --compile packages/cli/src/cli.tsx --outfile /out/claude-transcripts

# ── runtime: compose the built artifacts into a slim image ──────────────────
FROM oven/bun:1 AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY config ./config
# Prebuilt webui SPA (served at /app) + rendered docs (served at /docs).
COPY --from=build-webui /app/packages/webui/dist ./packages/webui/dist
COPY --from=build-docs /docs-dist ./docs
# COPY --from=build-cli /out/claude-transcripts /usr/local/bin/claude-transcripts

# Baked release version (passed by the publish workflow).
ARG CT_VERSION=0.0.0-dev
ENV CT_VERSION=${CT_VERSION}
# The webapi serves the built SPA at /app and the static docs at /docs from these dirs.
ENV CT_STATIC_DIR=/app/packages/webui/dist
ENV CT_DOCS_DIR=/app/docs
EXPOSE 7650
CMD ["bun", "run", "packages/webapi/src/index.ts"]
