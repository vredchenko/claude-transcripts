#!/bin/sh
# Claude Transcripts installer.
#
#   curl -fsSL https://raw.githubusercontent.com/vredchenko/claude-transcripts/main/install.sh | sh
#
# This wrapper deliberately does almost nothing: detect the platform, fetch the
# matching release binary, verify it, and hand over to `claude-transcripts install`,
# which does the actual work. Anything implemented here couldn't be tested, reused by a
# future `upgrade`, or run by someone who already has the binary — so it lives in the CLI.
# (`upgrade` is designed in docs/design/installation.md but is not implemented yet.)
#
#   CT_VERSION=v0.1.0   install a specific release (default: latest)
#   CT_BIN_DIR=~/.local/bin
#   CT_NO_RUN=1         install the binary only; don't run `install`
#
# POSIX sh, no bashisms: this has to run under dash, ash and busybox.
set -eu

REPO="vredchenko/claude-transcripts"
BIN_DIR="${CT_BIN_DIR:-$HOME/.local/bin}"
BIN_NAME="claude-transcripts"

info() { printf '  %s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "\`$1\` is required but not installed."
}

# ── Platform ────────────────────────────────────────────────────────────────
detect_target() {
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux) os_part="linux" ;;
    Darwin) os_part="darwin" ;;
    *) die "unsupported OS: $os (Linux and macOS only; on Windows use WSL2)" ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch_part="x64" ;;
    arm64 | aarch64) arch_part="arm64" ;;
    *) die "unsupported architecture: $arch" ;;
  esac
  printf '%s-%s' "$os_part" "$arch_part"
}

# ── Release resolution ──────────────────────────────────────────────────────
latest_version() {
  # Read the tag from the redirect to /releases/latest — no jq, no API token.
  curl -fsSLI -o /dev/null -w '%{url_effective}' \
    "https://github.com/$REPO/releases/latest" | sed 's#.*/tag/##'
}

main() {
  need curl
  need uname

  target="$(detect_target)"
  version="${CT_VERSION:-$(latest_version)}"
  [ -n "$version" ] || die "could not resolve the latest release version."

  asset="$BIN_NAME-$target"
  base="https://github.com/$REPO/releases/download/$version"

  printf 'Claude Transcripts %s (%s)\n' "$version" "$target"

  tmp="$(mktemp -d)"
  # Clean up on any exit, including the failures below.
  trap 'rm -rf "$tmp"' EXIT INT TERM

  info "downloading $asset"
  curl -fsSL "$base/$asset" -o "$tmp/$BIN_NAME" \
    || die "download failed: $base/$asset"

  # Verify against the release checksum. Piping a binary from the internet into your
  # shell's PATH without checking it is not something to be relaxed about — so a
  # missing or unreadable checksum is a failure, not a shrug.
  #
  # The file is `<asset>.sha256`, published per-asset by release-cli.yml. This used to
  # look for a combined `checksums.txt`, which no release has ever contained: the fetch
  # 404'd, the "no checksums published" branch ran, and every install silently skipped
  # verification while reporting success.
  curl -fsSL "$base/$asset.sha256" -o "$tmp/$asset.sha256" \
    || die "no checksum published for $asset at $version — refusing to install."

  # `sha256sum -c` needs the file beside the sum, and the sum names the original asset.
  expected="$(awk '{print $1}' "$tmp/$asset.sha256")"
  [ -n "$expected" ] || die "checksum file for $asset is empty — refusing to install."

  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp/$BIN_NAME" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$tmp/$BIN_NAME" | awk '{print $1}')"
  else
    die "no sha256sum or shasum available to verify the download — refusing to install."
  fi

  [ "$actual" = "$expected" ] || die "checksum mismatch for $asset — refusing to install."
  info "checksum verified"

  mkdir -p "$BIN_DIR"
  chmod +x "$tmp/$BIN_NAME"
  mv "$tmp/$BIN_NAME" "$BIN_DIR/$BIN_NAME"
  info "installed $BIN_DIR/$BIN_NAME"

  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) info "note: $BIN_DIR is not on your PATH — add: export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac

  [ "${CT_NO_RUN:-}" = "1" ] && { info "CT_NO_RUN=1 — skipping setup"; exit 0; }

  printf '\n'
  # Hand over. Everything real happens here.
  exec "$BIN_DIR/$BIN_NAME" install "$@"
}

main "$@"
