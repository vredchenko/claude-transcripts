# Helpers shared by the omnibus s6 scripts. Sourced, not run.

# s6-overlay's container environment: one file per variable, read by with-contenv.
# Variables passed to `docker run` are already here; the init writes the rest.
ENVDIR=/run/s6/container_environment
SECRETS=/data/secrets

log() { printf '[omnibus] %s\n' "$*"; }

# getenv NAME — the variable's value in the container environment ("" if unset).
getenv() { cat "$ENVDIR/$1" 2>/dev/null || true; }

# setenv_default NAME VALUE — set NAME unless the runner already gave it a value.
setenv_default() {
  [ -s "$ENVDIR/$1" ] || printf '%s' "$2" > "$ENVDIR/$1"
}

# secret NAME — from the environment if given; else the one persisted under
# /data/secrets on an earlier boot; else a fresh one, persisted for the next.
secret() {
  if [ -s "$ENVDIR/$1" ]; then return; fi
  if [ ! -s "$SECRETS/$1" ]; then
    (umask 077 && od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > "$SECRETS/$1")
    log "generated $1 (stored in $SECRETS/$1)"
  fi
  cp "$SECRETS/$1" "$ENVDIR/$1"
}

# The address to reach a service on from inside the container.
local_host() {
  case "$OMNIBUS_BIND" in 0.0.0.0 | "") echo 127.0.0.1 ;; *) echo "$OMNIBUS_BIND" ;; esac
}

# wait_http NAME URL [any] — poll until URL answers 2xx (or anything at all, with
# `any`), for up to OMNIBUS_WAIT_SECONDS. Returns 1 on timeout.
wait_http() {
  name="$1" url="$2" mode="${3:-ok}"
  deadline=$(( $(date +%s) + ${OMNIBUS_WAIT_SECONDS:-120} ))
  while :; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" || true)"
    case "$mode:$code" in
      ok:2??) log "$name ready"; return 0 ;;
      any:[1-5]??) log "$name answering"; return 0 ;;
    esac
    if [ "$(date +%s)" -ge "$deadline" ]; then
      log "$name not ready after ${OMNIBUS_WAIT_SECONDS:-120}s ($url → ${code:-no answer})"
      return 1
    fi
    sleep 1
  done
}
