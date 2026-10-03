# Fossil SCM — built from the official release source (https://fossil-scm.org).
#
# Fossil publishes no container image, only a Dockerfile in its source tree
# (www/containers.md). This is that file's recipe, pinned to a release instead of
# trunk and verified by checksum: a static, musl-linked binary on an empty base, so
# the image holds Fossil and nothing else. Hand-maintained (NOT generated); its
# version must equal the `fossil` service's `defaultTag` in
# packages/shared/src/model/services.ts — a test holds the two together.
#
# Build context is this directory and nothing is COPY'd from it, so the image builds
# the same from a repo checkout, a user install (which ships this file), or CI.
#
# To bump: take the release's tarball link from https://fossil-scm.org/home/uv/download.html,
# set FOSSIL_VERSION / FOSSIL_CHECKIN / FOSSIL_SHA256, and the model's defaultTag.

## ── build: a static Fossil binary ─────────────────────────────────────────
FROM alpine:3.22 AS build
RUN apk add --no-cache gcc make linux-headers musl-dev \
      openssl-dev openssl-libs-static zlib-dev zlib-static
ARG FOSSIL_VERSION=2.28
# The release check-in (`fossil version` prints its prefix) and the sha256 of the
# tarball fossil-scm.org serves for it.
ARG FOSSIL_CHECKIN=52445a27f116603d784ad753c6acd494e0b02aeaf8502ee0fee0aa30030f4c4e
ARG FOSSIL_SHA256=84c18824ca227e7602d2408b663c3747f754ad306ed5c73ddab959d6589538a6
WORKDIR /fsl
ADD --checksum=sha256:${FOSSIL_SHA256} \
    https://fossil-scm.org/home/tarball/${FOSSIL_CHECKIN}/fossil-src-${FOSSIL_VERSION}.tar.gz \
    src.tar.gz
RUN tar -xzf src.tar.gz --strip-components=1 \
  && ./configure --static --json CFLAGS='-Os -s' \
  && make -j"$(nproc)" \
  && ./fossil version | grep -q "version ${FOSSIL_VERSION} "

## ── os: the few files a scratch image still needs ─────────────────────────
FROM busybox:1.37 AS os
RUN mkdir -p /e /museum \
  && echo "root:x:0:0:Admin:/:/false" > /e/passwd \
  && echo "root:x:0:root" > /e/group

## ── run ───────────────────────────────────────────────────────────────────
FROM scratch
COPY --from=build --chmod=755 /fsl/fossil /bin/fossil
COPY --from=os /e/passwd /e/group /etc/
COPY --from=os --chmod=1777 /tmp /tmp/
COPY --from=os /museum /museum/
ENV PATH=/bin
EXPOSE 8080/tcp
# Runs as root, unlike upstream's image (a fixed UID 499). The repo lives on a
# bind mount or volume created by whoever runs the stack, and a fixed UID can't write
# to a directory it doesn't own. Fossil handles root itself: serving a repository
# file owned by a non-root user, it chroots into the repo's directory and drops to
# that user (`chown` the repo to opt in). See https://fossil-scm.org/home/help/server.
ENTRYPOINT ["fossil", "server"]
# Serve the directory, not a file: every `<name>.fossil` in /museum is served at
# /<name>/, and "/" lists them. Nothing is created — upstream's `--create` would make a
# repository with a generated admin login, and ours is seeded by the app instead
# (named by `fossil.repositories` in config/). Until then the list is empty.
# --jsmode bundled: one JS file, fewer requests.
CMD ["--repolist", "--jsmode", "bundled", "/museum"]
