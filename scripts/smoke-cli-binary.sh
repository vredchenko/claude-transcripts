#!/bin/sh
# Smoke-test one release binary on the platform it was built for (ADR 0036).
#
#   sh scripts/smoke-cli-binary.sh <asset> <dir of release assets> <expected version>
#
#   SMOKE_DETECTED=true   install.sh must pick <asset> on its own here (else it is named
#                         with CT_INSTALL_TARGET: a pre-AVX2 CPU can't be detected on a
#                         runner that has AVX2)
#   SMOKE_QEMU_CPU=Nehalem  run the binary under qemu-x86_64 with that CPU model
#
# Run by release-cli.yml, natively or inside a container (`docker run … alpine:3 sh
# scripts/smoke-cli-binary.sh …`); the same command works locally. POSIX sh, so it
# runs under busybox.
#
# QEMU's user-mode emulation executes AVX2 instructions whatever CPU model it is given,
# so a baseline run proves the binary starts on that model, not that it avoids AVX2.
# That guarantee is Bun's (its `-baseline` targets).
set -eu

asset="$1"
dir="$(cd "$2" && pwd)"
want="$3"
qemu="${SMOKE_QEMU_CPU:-}"
detected="${SMOKE_DETECTED:-false}"
here="$(cd "$(dirname "$0")/.." && pwd)"

fail() { printf 'smoke(%s): FAIL: %s\n' "$asset" "$*" >&2; exit 1; }
ok() { printf 'smoke(%s): ok: %s\n' "$asset" "$*"; }

# A bare container has neither curl (install.sh) nor qemu. Install what's missing when
# we can (root in a container); a runner already has curl and gets no qemu entries.
setup() {
  [ "$(id -u)" = 0 ] || return 0
  if command -v apk >/dev/null 2>&1; then
    apk add -q curl
    [ -z "$qemu" ] || apk add -q qemu-x86_64
  elif command -v apt-get >/dev/null 2>&1; then
    pkgs="curl ca-certificates"
    [ -z "$qemu" ] || pkgs="$pkgs qemu-user"
    apt-get update -qq >/dev/null
    # shellcheck disable=SC2086
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $pkgs >/dev/null
  fi
}
setup

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM
export HOME="$tmp/home"
mkdir -p "$HOME"

[ "$detected" = "true" ] || export CT_INSTALL_TARGET="$asset"
install() {
  CT_DOWNLOAD_URL="file://$dir" CT_BIN_DIR="$tmp/bin" CT_NO_RUN=1 sh "$here/install.sh"
}

# On musl, a minimal system lacks the C++ runtime the binary links. The installer must
# say so (before downloading) and say how to fix it; then fix it and carry on.
if [ -e /etc/alpine-release ] && [ ! -e /usr/lib/libstdc++.so.6 ]; then
  if install >"$tmp/out" 2>&1; then fail "install.sh installed a musl build without libstdc++"; fi
  grep -q "apk add libstdc++ libgcc" "$tmp/out" || { cat "$tmp/out"; fail "no libstdc++ hint"; }
  ok "install.sh refuses without libstdc++ and names the fix"
  apk add -q libstdc++ libgcc
fi

install
bin="$tmp/bin/claude-transcripts"
cmp -s "$bin" "$dir/claude-transcripts-$asset" \
  || fail "install.sh installed something other than claude-transcripts-$asset"
if [ "$detected" = "true" ]; then ok "install.sh picked $asset by itself"; fi

run() {
  if [ -n "$qemu" ]; then qemu-x86_64 -cpu "$qemu" "$bin" "$@"; else "$bin" "$@"; fi
}

got="$(run --version)"
[ "$got" = "$want" ] || fail "--version says $got, want $want"
ok "--version is $want${qemu:+ (qemu -cpu $qemu)}"

run --help >"$tmp/help"
grep -q "Claude Transcripts" "$tmp/help" || fail "--help printed no usage"
ok "--help renders"

# The hook path, offline: no instance is configured, so it must still exit 0 (it never
# blocks a session) and tell Claude Code it isn't recording.
payload='{"hook_event_name":"SessionStart","session_id":"00000000-0000-4000-8000-000000000001","cwd":"/tmp","source":"startup","transcript_path":"/tmp/none.jsonl"}'
out="$(printf '%s' "$payload" | run hook run)" || fail "hook run exited non-zero"
case "$out" in
  *systemMessage*) ok "hook run handles an event offline" ;;
  *) fail "hook run printed no systemMessage: $out" ;;
esac
