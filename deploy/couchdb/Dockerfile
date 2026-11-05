# CouchDB: the official image, minus what this stack never runs, with its Debian
# packages brought up to date.
#
# The upstream image fails the project's scan gate on one thing alone: Nouveau,
# CouchDB's optional Java search service, whose bundled Jetty, Jackson and Guava carry
# fixed HIGH findings. Nothing here enables Nouveau (Meilisearch does search), so it's
# removed, and the OS packages are upgraded so the image also clears fixed Debian
# advisories between upstream rebuilds. Everything else (entrypoint, config, user, data
# path) is upstream's, so this is a drop-in for `couchdb:<tag>`. The omnibus makes the
# same two changes to the same base.
#
# Hand-maintained (NOT generated). COUCHDB_VERSION must equal the `couchdb` service's
# `defaultTag` in packages/shared/src/blueprint/services.ts; a test holds them together.
# To bump: change both, and re-pin the digest (`docker buildx imagetools inspect
# couchdb:<tag>`).
ARG COUCHDB_VERSION=3
ARG COUCHDB_IMAGE=couchdb:3@sha256:4e8e0a366208a87d5059b0f4fcbefff13c32401a655d4629c19be6288ea77675

FROM ${COUCHDB_IMAGE}
RUN set -eux; \
  apt-get update; \
  apt-get upgrade -y --no-install-recommends; \
  apt-get clean; rm -rf /var/lib/apt/lists/*; \
  rm -rf /opt/couchdb/nouveau
