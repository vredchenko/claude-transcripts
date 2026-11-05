# Meilisearch UI (https://github.com/riccox/meilisearch-ui): its single-page app, built
# once and served as static files.
#
# The upstream image is a full Node/Debian development image (ImageMagick, Perl,
# Python, libpq, pnpm…) because it runs a vite build every time the container starts.
# Nearly all of that is build tooling the running UI never touches, and it fails the
# project's scan gate many times over. This builds the same release's SPA in the
# upstream image, then serves it from a minimal unprivileged nginx on the same port
# (24900), so it's a drop-in for the upstream image. The omnibus builds it the same
# way and serves it with deploy/omnibus/serve-static.ts.
#
# Hand-maintained (NOT generated). MEILI_UI_VERSION must equal the `meilisearch-ui`
# service's `defaultTag` in packages/shared/src/blueprint/services.ts; a test holds them
# together. To bump: change both, and re-pin the digests.
ARG MEILI_UI_VERSION=v0.14.1
ARG MEILI_UI_IMAGE=riccoxie/meilisearch-ui:v0.14.1@sha256:f911cccfa54ab4cd75f9f43627ee4995e51061cf026b059db894aaeadecc3a8f
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.31-alpine@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e

## ── build: the SPA, once (the same files on every arch) ──────────────────────
FROM --platform=$BUILDPLATFORM ${MEILI_UI_IMAGE} AS build
WORKDIR /opt/meilisearch-ui
RUN BASE_PATH=/ pnpm run build:docker

## ── runtime: static files behind nginx, as an unprivileged user ──────────────
FROM ${NGINX_IMAGE}
USER root
RUN apk upgrade --no-cache
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /opt/meilisearch-ui/dist /usr/share/nginx/html
USER 101
EXPOSE 24900
