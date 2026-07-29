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
# --ignore-scripts: the root `postinstall` installs lefthook's git hooks, which
# needs a `git` binary and a `.git` dir — neither exists in this image (nor should
# they: an image has no working tree to hook). We declare no trustedDependencies,
# so this skips nothing else.
RUN bun install --frozen-lockfile --ignore-scripts || bun install --ignore-scripts

# ── prod-deps: the same install WITHOUT devDependencies, for the runtime stage ─
# The build stages need vite/esbuild/typescript; the runtime needs none of them.
# Shipping them would put the whole dev toolchain's vulnerability surface into the
# published image (esbuild's Go runtime, biome, orval, …) — which the release gate
# (grype/trivy, fail on HIGH) rightly counts against us.
FROM deps AS prod-deps
RUN rm -rf node_modules \
  && (bun install --frozen-lockfile --production --ignore-scripts \
      || bun install --production --ignore-scripts)

# ── build-webui: the React SPA → packages/webui/dist ────────────────────────
FROM deps AS build-webui
RUN bun run build

# ── build-docs: docs/*.md → self-contained static HTML (dependency-free) ────
FROM deps AS build-docs
COPY scripts ./scripts
COPY docs ./docs
COPY brand ./brand
RUN bun run scripts/build-docs.ts --out /docs-dist

# ── build-cli: compile the CLI to a single self-contained binary ────────────
FROM deps AS build-cli
RUN bun build --compile packages/cli/src/cli.tsx --outfile /out/claude-transcripts

# ── runtime: compose the built artifacts into a slim image ──────────────────
FROM oven/bun:1 AS runtime
WORKDIR /app
# Patch the base OS packages. The published base image lags behind Debian security
# updates by however long since its last rebuild, and those CVEs are counted against
# this image by the release gate (grype/trivy, fail on HIGH) — so patch rather than
# waiting on an upstream rebuild. Runs as root, which is the base image's default.
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*
# Runtime dependencies only — no dev toolchain (see the prod-deps stage).
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY config ./config
# Prebuilt webui SPA (served at /app) + rendered docs (served at /docs).
COPY --from=build-webui /app/packages/webui/dist ./packages/webui/dist
COPY --from=build-docs /docs-dist ./docs
# Bundled CLI binary — on PATH for exec-into-container use, and served for download.
COPY --from=build-cli /out/claude-transcripts /usr/local/bin/claude-transcripts

# Baked release version (passed by the publish workflow).
ARG CT_VERSION=0.0.0-dev
ENV CT_VERSION=${CT_VERSION}
# The webapi serves the built SPA at /app and the static docs at /docs from these dirs.
ENV CT_STATIC_DIR=/app/packages/webui/dist
ENV CT_DOCS_DIR=/app/docs
# The webui's "Download CLI" link streams this binary via /cli/download.
ENV CT_CLI_BIN=/usr/local/bin/claude-transcripts
EXPOSE 7650
CMD ["bun", "run", "packages/webapi/src/index.ts"]
