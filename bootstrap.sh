#!/usr/bin/env bash
# bootstrap.sh — remote entry point for a fresh machine.
#   curl -fsSL https://raw.githubusercontent.com/pavp/dotfiles/main/bootstrap.sh | bash
#
# Installs git (via Xcode CLT on macOS), clones the repo, runs install.sh.

set -euo pipefail

REPO="https://github.com/pavp/dotfiles.git"
DOTFILES_DIR="${DOTFILES_DIR:-$HOME/.dotfiles}"
OS="$(uname -s)"

log() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }

# ── git (macOS: Xcode Command Line Tools) ───────────────────────────
if ! command -v git >/dev/null 2>&1; then
  if [ "$OS" = "Darwin" ]; then
    log "installing Xcode Command Line Tools (provides git)"
    xcode-select --install || true
    until command -v git >/dev/null 2>&1; do sleep 5; done
  else
    log "git missing — install it via your package manager, then re-run"
    exit 1
  fi
fi

# ── clone or update ─────────────────────────────────────────────────
if [ -d "$DOTFILES_DIR/.git" ]; then
  log "updating existing clone at $DOTFILES_DIR"
  git -C "$DOTFILES_DIR" pull --ff-only
else
  log "cloning $REPO -> $DOTFILES_DIR"
  git clone "$REPO" "$DOTFILES_DIR"
fi

# ── hand off to installer ───────────────────────────────────────────
log "running install.sh"
DOTFILES_DIR="$DOTFILES_DIR" exec "$DOTFILES_DIR/install.sh"
