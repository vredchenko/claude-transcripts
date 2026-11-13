# syntax=docker/dockerfile:1
#
# Garage Web UI (https://github.com/khairul169/garage-webui), rebuilt from its release
# source.
#
# The published image's binary is built with Go 1.23, whose standard library carries
# dozens of fixed HIGH/CRITICAL advisories, and pins golang.org/x/crypto at a version
# with more. This is the same release, built with the upstream Makefile's flags, a
# current Go, and that one module raised to its fixed version. The result is a drop-in
# for the upstream image: the same binary path, entrypoint and port (3909), on an
# empty base with CA certificates only.
#
# Hand-maintained (NOT generated). GARAGE_UI_VERSION must equal the `garage-ui`
# service's `defaultTag` in packages/shared/src/blueprint/services.ts; a test holds
# them together. The omnibus image copies its binary from this build too.
#
# To bump: set GARAGE_UI_VERSION and GARAGE_UI_COMMIT (`git ls-remote` the tag), and
# the blueprint's defaultTag.
#
# Build context is this directory; nothing is COPY'd from it, so it builds the same from
# a checkout, a user install or CI, and with Docker (BuildKit) or Podman.

ARG NODE_IMAGE=node:22-trixie-slim@sha256:8eb619e402eaede1748a3c8173bffab391592812e85136452f781741c7242ddf
ARG GO_IMAGE=golang:1.27-trixie@sha256:c47c3fda018d13d43a6bf5ebac3e5bba8a23a35782aa4faf531afaf47c64c39f

## ── the source, at the release's commit ─────────────────────────────────────
# Fetched by commit, not by tag, and checked: a moved tag fails the build instead of
# changing what it compiles.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS web
ARG GARAGE_UI_VERSION=1.1.0
ARG GARAGE_UI_COMMIT=a6640157c1a757c92aa539149df0d902283e6763
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${GARAGE_UI_VERSION}" \
      https://github.com/khairul169/garage-webui.git /src \
  && test "$(git -C /src rev-parse HEAD)" = "${GARAGE_UI_COMMIT}"
WORKDIR /src
# The UI is go:embed'ed into the binary, so it builds first.
RUN npm install -g pnpm@9 && pnpm install --frozen-lockfile && pnpm run build

## ── the binary ─────────────────────────────────────────────────────────────
# Runs on the build platform and cross-compiles for the target one.
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS build
ARG TARGETOS TARGETARCH
COPY --from=web /src/backend /src
COPY --from=web /src/dist /src/ui/dist
WORKDIR /src
ARG XCRYPTO_VERSION=v0.55.0
RUN GOTOOLCHAIN=local go get golang.org/x/crypto@${XCRYPTO_VERSION} && GOTOOLCHAIN=local go mod tidy
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} GOTOOLCHAIN=local \
      go build -trimpath -ldflags=-s -tags=prod -o /garage-webui main.go

## ── runtime: the binary and CA certificates, nothing else ──────────────────
FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /garage-webui /bin/main
EXPOSE 3909
ENTRYPOINT ["/bin/main"]
