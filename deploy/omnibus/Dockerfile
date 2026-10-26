# syntax=docker/dockerfile:1
#
# Claude Transcripts omnibus — the whole stack in one container, under s6-overlay.
#
#   CouchDB + Garage (+ web UI) + Meilisearch (+ UI) + Fossil + the app (webapi, webui,
#   docs), the CLI on PATH, the CLI for every platform and the Claude Code plugin at
#   /downloads/, a fetch-only clone of the source repo, and the GitHub CLI (no creds).
#
# A distribution format, not the reference architecture: the compose stack and the
# Kubernetes base (one container per service) stay the way to run it properly. See
# docs/operate/omnibus.md for what it trades away.
#
# It ASSEMBLES component images rather than rebuilding them, so it can't drift from
# what the compose stack and k8s run: the app image (root Dockerfile) and the Fossil
# image (deploy/fossil/Dockerfile) come in as APP_IMAGE / FOSSIL_IMAGE. docker-bake.hcl
# builds all three as one graph:
#
#   bun run omnibus:build          # bake → claude-transcripts-omnibus:local
#   bun run omnibus:smoke          # boot it twice on a scratch volume and check it
#
# Build context is the repo root (it copies the plugin from hooks/).

# ── component images ────────────────────────────────────────────────────────────
# Upstream images are pinned by tag AND digest (multi-arch index digests: amd64 + arm64).
# The tags must equal the blueprint's defaultTag for each service
# (packages/shared/src/blueprint/services.ts); packages/shared/src/blueprint/omnibus.test.ts checks.
ARG COUCHDB_IMAGE=couchdb:3@sha256:4e8e0a366208a87d5059b0f4fcbefff13c32401a655d4629c19be6288ea77675
ARG GARAGE_IMAGE=dxflrs/garage:v2.3.0@sha256:866bd13ed2038ba7e7190e840482bc27234c4afaf77be8cfa439ae088c1e4690
# Toolchains for the one component rebuilt from source here (garage-webui, below).
ARG NODE_IMAGE=node:22-trixie-slim@sha256:8eb619e402eaede1748a3c8173bffab391592812e85136452f781741c7242ddf
ARG GO_IMAGE=golang:1.27-trixie@sha256:fbb7ae40b62ff8afe31662df570d39b4f5052ac32b90dae8e60d7657a20a74f4
ARG GARAGE_UI_VERSION=1.1.0
ARG MEILI_UI_IMAGE=riccoxie/meilisearch-ui:v0.14.1@sha256:f911cccfa54ab4cd75f9f43627ee4995e51061cf026b059db894aaeadecc3a8f
ARG ALPINE_IMAGE=alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f
# Ours. Defaults are the tags the compose --build/--upstream paths give local builds;
# bake replaces them with its own build contexts, and a release passes the app image
# it just published.
ARG APP_IMAGE=claude-transcripts-app:local
ARG FOSSIL_IMAGE=claude-transcripts-fossil:2.28-local

FROM ${GARAGE_IMAGE} AS garage
FROM ${FOSSIL_IMAGE} AS fossil
FROM ${APP_IMAGE} AS app

# ── s6-overlay: PID 1, supervision, init ordering ──────────────────────────────
# Tarballs per upstream's install docs, checksummed. One stage per arch, because
# ADD --checksum takes a literal.
FROM ${ALPINE_IMAGE} AS s6-base
ARG S6_OVERLAY_VERSION=3.2.3.0
ADD --checksum=sha256:b720f9d9340efc8bb07528b9743813c836e4b02f8693d90241f047998b4c53cf \
    https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz /tmp/
FROM s6-base AS s6-amd64
ADD --checksum=sha256:a93f02882c6ed46b21e7adb5c0add86154f01236c93cd82c7d682722e8840563 \
    https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-x86_64.tar.xz /tmp/arch.tar.xz
FROM s6-base AS s6-arm64
ADD --checksum=sha256:0952056ff913482163cc30e35b2e944b507ba1025d78f5becbb89367bf344581 \
    https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-aarch64.tar.xz /tmp/arch.tar.xz
FROM s6-${TARGETARCH} AS s6
RUN mkdir /s6 \
  && tar -C /s6 -Jxpf /tmp/s6-overlay-noarch.tar.xz \
  && tar -C /s6 -Jxpf /tmp/arch.tar.xz

# ── Meilisearch ────────────────────────────────────────────────────────────────
# The upstream image's binary is linked against musl (Alpine); the base here is Debian,
# so take the glibc release binary instead. Same version the image tag resolves to.
FROM ${ALPINE_IMAGE} AS meili-base
ARG MEILI_VERSION=1.10.3
FROM meili-base AS meili-amd64
ADD --checksum=sha256:8946358502de404c89ba2f0c9d8e0b1aa639d1a285e94311da4d16e8d43ec62f \
    https://github.com/meilisearch/meilisearch/releases/download/v${MEILI_VERSION}/meilisearch-linux-amd64 /meilisearch
FROM meili-base AS meili-arm64
ADD --checksum=sha256:b9c1e5aa1ec0e08a4d57ad81dc1839aa6b086c64b3be9766b892581fa8396200 \
    https://github.com/meilisearch/meilisearch/releases/download/v${MEILI_VERSION}/meilisearch-linux-aarch64 /meilisearch
FROM meili-${TARGETARCH} AS meili

# ── Garage web UI: rebuilt from its release source ─────────────────────────────
# The published image's binary is built with Go 1.23, whose standard library carries
# dozens of fixed HIGH/CRITICAL advisories — enough on its own to fail the release
# scan — and pins golang.org/x/crypto at a version with more. Same tag, same Makefile
# flags, a current Go and that one module raised to its fixed version. The UI is
# go:embed'ed, so the frontend builds first; both run on the build platform (the Go
# build cross-compiles).
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS garage-ui-web
ARG GARAGE_UI_VERSION
ADD https://github.com/khairul169/garage-webui.git#${GARAGE_UI_VERSION} /src
WORKDIR /src
RUN npm install -g pnpm@9 && pnpm install --frozen-lockfile && pnpm run build

FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS garage-ui
ARG TARGETOS TARGETARCH
COPY --from=garage-ui-web /src/backend /src
COPY --from=garage-ui-web /src/dist /src/ui/dist
WORKDIR /src
ARG XCRYPTO_VERSION=v0.55.0
RUN GOTOOLCHAIN=local go get golang.org/x/crypto@${XCRYPTO_VERSION} && GOTOOLCHAIN=local go mod tidy
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH GOTOOLCHAIN=local \
      go build -trimpath -ldflags=-s -tags=prod -o /garage-webui main.go

# ── Meilisearch UI: the upstream image builds its SPA at container start (vite) ──
# Build it once here instead and serve the static files. Same files on every arch.
FROM --platform=$BUILDPLATFORM ${MEILI_UI_IMAGE} AS meili-ui
WORKDIR /opt/meilisearch-ui
RUN BASE_PATH=/ pnpm run build:docker

# ── downloads: the CLI for every platform + the Claude Code plugin ─────────────
# Cross-compiled from the app image's own sources, so the binaries are the same
# version as the app (and the CLI on this container's PATH). Same flags as the
# release workflow (release-cli.yml); --splitting is the #146 fix.
FROM --platform=$BUILDPLATFORM ${APP_IMAGE} AS downloads
WORKDIR /app
RUN set -eu; mkdir -p /downloads; \
  for t in linux-x64 linux-arm64 darwin-x64 darwin-arm64; do \
    bun build --compile --splitting --target="bun-$t" packages/cli/src/cli.tsx \
      --define "process.env.CT_VERSION='${CT_VERSION}'" \
      --outfile "/downloads/claude-transcripts-$t"; \
  done
# The plugin as a self-contained local marketplace: `claude plugin marketplace add`
# takes the extracted directory.
COPY .claude-plugin /plugin/claude-transcripts-plugin/.claude-plugin
COPY hooks /plugin/claude-transcripts-plugin/hooks
COPY deploy/omnibus/downloads.html /downloads/index.html
RUN set -eu; \
  tar -C /plugin -czf /downloads/claude-transcripts-plugin.tar.gz claude-transcripts-plugin; \
  cd /downloads; for f in claude-transcripts-*; do sha256sum "$f" > "$f.sha256"; done; \
  sed -i "s/@VERSION@/${CT_VERSION}/g" index.html

# ── the runtime ────────────────────────────────────────────────────────────────
# On the CouchDB image: an Erlang release plus its system libraries is the one thing
# here that doesn't transplant. It's Debian (trixie), like the Bun image the app is
# built on, so the app's bun binary runs on it unchanged.
FROM ${COUCHDB_IMAGE} AS runtime
# The GitHub CLI's apt repo: its own keyring, signed-by scoped to that one source.
ADD https://cli.github.com/packages/githubcli-archive-keyring.gpg /etc/apt/keyrings/githubcli.gpg
RUN set -eux; \
  chmod 644 /etc/apt/keyrings/githubcli.gpg; \
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list; \
  apt-get update; \
  apt-get upgrade -y --no-install-recommends; \
  apt-get install -y --no-install-recommends git gh xz-utils; \
  apt-get clean; rm -rf /var/lib/apt/lists/*; \
  # Nouveau, CouchDB's optional Java search service: never enabled here (Meilisearch
  # does search), and its bundled Jetty and Jackson are the rest of what the scan flags.
  rm -rf /opt/couchdb/nouveau

COPY --from=s6 /s6/ /
COPY --from=garage /garage /usr/local/bin/garage
COPY --from=garage-ui /garage-webui /usr/local/bin/garage-webui
COPY --from=meili --chmod=755 /meilisearch /usr/local/bin/meilisearch
COPY --from=meili-ui /opt/meilisearch-ui/dist /opt/omnibus/meilisearch-ui
COPY --from=fossil /bin/fossil /usr/local/bin/fossil
COPY --from=fossil /bin/fossil-entrypoint /opt/omnibus/fossil-entrypoint.sh
COPY --from=app /usr/local/bin/bun /usr/local/bin/bun
COPY --from=app /app /app
COPY --from=app /usr/local/bin/claude-transcripts /usr/local/bin/claude-transcripts
COPY --from=downloads /downloads /opt/omnibus/downloads
# Provisioning reuses the dev stack's Garage bootstrap rather than a second copy of it.
COPY scripts/bootstrap-garage.ts /app/scripts/bootstrap-garage.ts
COPY scripts/lib/config-file.ts /app/scripts/lib/config-file.ts
COPY deploy/omnibus/omnibus-env.ts deploy/omnibus/serve-static.ts /app/deploy/omnibus/
COPY deploy/omnibus/rootfs/ /

# ── the source repo: a fetch-only clone ────────────────────────────────────────
# Cloned by BuildKit at build time and fetched again on every boot (best-effort). Push
# is disabled twice over: the remote has no push URL, and a system-wide pre-push hook
# refuses any push from any repository in the container.
ARG OMNIBUS_GIT_URL=https://github.com/vredchenko/claude-transcripts.git
ARG OMNIBUS_GIT_REF=main
ADD --keep-git-dir=true ${OMNIBUS_GIT_URL}#${OMNIBUS_GIT_REF} /workspace/claude-transcripts
RUN set -eu; \
  git config --system core.hooksPath /etc/git/hooks; \
  git config --system --add safe.directory '*'; \
  cd /workspace/claude-transcripts; \
  git remote remove origin 2>/dev/null || true; \
  git remote add origin "${OMNIBUS_GIT_URL}"; \
  git remote set-url --push origin "push-disabled-in-omnibus"; \
  git checkout -q -B "${OMNIBUS_GIT_REF}" 2>/dev/null || true

# ── run ────────────────────────────────────────────────────────────────────────
ENV PATH=/opt/omnibus/bin:/command:$PATH \
    # The interface the backing services and admin UIs bind inside the container. Only
    # 7650 (the webapi) is EXPOSEd; publishing any of the others is the runner's call.
    # 127.0.0.1 makes them unreachable from outside the container even when published.
    OMNIBUS_BIND=0.0.0.0 \
    WEBAPI_HOST=0.0.0.0 \
    WEBAPI_PORT=7650 \
    CT_STATIC_DIR=/app/packages/webui/dist \
    CT_DOCS_DIR=/app/docs \
    CT_CLI_BIN=/usr/local/bin/claude-transcripts \
    CT_DOWNLOADS_DIR=/opt/omnibus/downloads \
    # gh: never prompt, never look for a token it wasn't given.
    GH_PROMPT_DISABLED=1 \
    # Provisioning waits on daemons, so don't cap stage 2; a core service that won't
    # start stops the container instead of leaving it half up.
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0 \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2
VOLUME /data
EXPOSE 7650
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD ["/opt/omnibus/bin/omnibus-health"]
ENTRYPOINT ["/init"]
