# Combined application image: webapi + built webui SPA + Scalar (+ bundled CLI).
# Components are built then combined (ADR 0023). Skeleton — refine as packages land.
#
# This is the root app Dockerfile. Other images (base Bun runtime, Claude-Code
# runtime, CLI-utils, mirrored backing services, …) will get their own Dockerfiles
# (likely under dockerfiles/) as they're built — see docs/containers.md.

FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* bunfig.toml tsconfig.base.json ./
COPY packages ./packages
RUN bun install --frozen-lockfile || bun install
# Build the webui SPA → packages/webui/dist
RUN bun run build
# TODO: bun build --compile the CLI binary into /app/bin/claude-transcripts

FROM oven/bun:1 AS runtime
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY config ./config
# Baked release version (passed by the publish workflow).
ARG CT_VERSION=0.0.0-dev
ENV CT_VERSION=${CT_VERSION}
# The webapi serves the built SPA at /app from this dir.
ENV CT_STATIC_DIR=/app/packages/webui/dist
EXPOSE 7650
CMD ["bun", "run", "packages/webapi/src/index.ts"]
