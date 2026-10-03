#!/bin/sh
# Seed, then serve. Run by busybox sh inside the Fossil image (deploy/fossil/Dockerfile).
#
# FOSSIL_REPOSITORIES names the repositories this instance owns, comma-separated —
# projected from `fossil.repositories` in config/ (ADR 0031). Each one missing from
# the data directory is created here, because Fossil has no HTTP call that creates a
# repository: the seed has to run where the binary and the volume are. Existing
# repositories are never touched, so a restart is a no-op.
#
# A seeded repository needs no login to READ: the built-in `nobody` user can browse,
# clone and download (ADR 0020). It can't write. Fossil's JSON API takes parameters
# from the query string, so with write capabilities a plain GET could change the
# repository — and any web page the user visits can send one to a localhost port
# (an <img> tag is enough). The admin user exists because Fossil requires one; its
# generated password is discarded, and `fossil user password` sets one when needed.
#
# FOSSIL_MUSEUM and FOSSIL_BUSYBOX exist for the tests (entrypoint.test.ts); the image
# uses the defaults.
set -euf # -f: an entry like `*` must stay a (rejected) name, not glob the cwd

museum="${FOSSIL_MUSEUM:-/museum}"
bb="${FOSSIL_BUSYBOX-/bin/busybox}"

# Read-only for anonymous visitors: check-out/browse (o), clone (g), wiki (j), tickets
# (r), hyperlinks (h), zip/tarball downloads (z).
NOBODY_CAPS="ghjorz"

# What a new repository holds beyond `fossil new` and its users. A placeholder: the
# seed's contents (users and roles, wiki, ticket schema, tags, settings) are still to
# be defined — https://github.com/vredchenko/claude-transcripts/issues/210. Runs once,
# on the not-yet-served copy, so anything added here must only ever create.
seed_content() {
  : "$1"
}

trim() {
  s="$1"
  while :; do
    case "$s" in
      [[:space:]]*) s="${s#?}" ;;
      *[[:space:]]) s="${s%?}" ;;
      *) break ;;
    esac
  done
  printf '%s' "$s"
}

IFS=','
for entry in ${FOSSIL_REPOSITORIES:-}; do
  name="$(trim "$entry")"
  [ -n "$name" ] || continue
  # The URL rules `fossil server` applies to a repository directory, so a name that
  # can't be served is refused here rather than created and then unreachable.
  case "$name" in
    -* | *[!A-Za-z0-9_-]*)
      echo "fossil-seed: skipping '$name' (letters, digits, '-' and '_' only)" >&2
      continue
      ;;
  esac
  repo="$museum/$name.fossil"
  [ -e "$repo" ] && continue
  # Built under a name `--repolist` doesn't serve, then renamed: a seed interrupted
  # half-way leaves no half-made repository to be served or skipped forever.
  $bb rm -f "$repo.new"
  fossil new --admin-user claude-transcripts --project-name "$name" "$repo.new" >/dev/null
  fossil user capabilities nobody "$NOBODY_CAPS" -R "$repo.new" >/dev/null
  seed_content "$repo.new"
  $bb mv "$repo.new" "$repo"
  echo "fossil-seed: created $repo (anonymous read-only)"
done
unset IFS

exec fossil server "$@"
