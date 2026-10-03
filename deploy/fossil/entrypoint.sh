#!/bin/sh
# Seed, then serve. Run by busybox sh inside the Fossil image (deploy/fossil/Dockerfile).
#
# FOSSIL_REPOSITORIES names the repositories this instance owns, comma-separated —
# projected from `fossil.repositories` in config/ (ADR 0031). Each one missing from
# /museum is created here, because Fossil has no HTTP call that creates a repository:
# the seed has to run where the binary and the volume are. Existing repositories are
# never touched, so a restart is a no-op.
#
# A seeded repository has no auth, like the rest of the bundled stack (ADR 0020): the
# built-in `nobody` user gets every capability. Its admin user exists because Fossil
# requires one; the generated password is discarded, as nothing needs it.
set -eu

# What a new repository holds beyond `fossil new` and no-auth. A placeholder: the seed's
# contents (users and roles, wiki, ticket schema, tags, settings) are still to be
# defined — https://github.com/vredchenko/claude-transcripts/issues/210. Runs once, on
# the not-yet-served copy, so anything added here must only ever create.
seed_content() {
  : "$1"
}

IFS=','
for name in ${FOSSIL_REPOSITORIES:-}; do
  name="${name# }"
  name="${name% }"
  [ -n "$name" ] || continue
  # The URL rules `fossil server` applies to a repository directory, so a name that
  # can't be served is refused here rather than created and then unreachable.
  case "$name" in
    -* | *[!A-Za-z0-9_-]*)
      echo "fossil-seed: skipping '$name' (letters, digits, '-' and '_' only)" >&2
      continue
      ;;
  esac
  repo="/museum/$name.fossil"
  [ -e "$repo" ] && continue
  # Built under a name `--repolist` doesn't serve, then renamed: a seed interrupted
  # half-way leaves no half-made repository to be served or skipped forever.
  /bin/busybox rm -f "$repo.new"
  fossil new --admin-user claude-transcripts --project-name "$name" "$repo.new" >/dev/null
  fossil user capabilities nobody s -R "$repo.new" >/dev/null
  seed_content "$repo.new"
  /bin/busybox mv "$repo.new" "$repo"
  echo "fossil-seed: created $repo (no auth: nobody has every capability)"
done
unset IFS

exec fossil server "$@"
