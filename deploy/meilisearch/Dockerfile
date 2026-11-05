# Meilisearch: the official image with its Alpine packages brought up to date.
#
# The v1.10 image upstream publishes was last built in October 2024. Its Alpine base
# (OpenSSL, curl, musl) has since collected fixed HIGH and CRITICAL advisories, which
# fail the project's scan gate; Meilisearch's own binary has none. Upstream won't rebuild
# an old minor, so this layers `apk upgrade` on the same image. Everything else
# (entrypoint, binary, data path /meili_data, port 7700) is upstream's, so this is a
# drop-in for `getmeili/meilisearch:<tag>`.
#
# Hand-maintained (NOT generated). MEILI_VERSION must equal the `meilisearch` service's
# `defaultTag` in packages/shared/src/blueprint/services.ts; a test holds them together.
# To bump: change both, and re-pin the digest (`docker buildx imagetools inspect
# getmeili/meilisearch:<release>`).
ARG MEILI_VERSION=v1.10
ARG MEILI_IMAGE=getmeili/meilisearch:v1.10.3@sha256:9d1b9b02fe6c68f60b54ce40092d8078f051b9341c400c90f907607636b7c9c1

FROM ${MEILI_IMAGE}
RUN apk upgrade --no-cache
