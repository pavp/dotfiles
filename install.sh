#!/usr/bin/env bash
# install.sh — idempotent dotfiles installer.
# State-check before act: skip if already correct, back up before overwriting.
#
# Usage:
#   ./install.sh            install everything
#   ./install.sh --dry-run  print what would happen, change nothing
#
# Env:
#   DOTFILES_DIR  repo location (default: this script's directory)

# No `set -e`: an installer touches many external commands that can fail
# legitimately (partial brew bundle, npm, optional agents). We handle errors
# explicitly (|| true, skip logic) instead of aborting the whole run.
set -uo pipefail

DOTFILES_DIR="${DOTFILES_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
BACKUP_DIR="$HOME/.dotfiles-backup/$(date +%Y%m%d-%H%M%S)"
DRY_RUN=false
if [ "${1:-}" = "--dry-run" ]; then DRY_RUN=true; fi

OS="$(uname -s)"

# ── Output helpers ──────────────────────────────────────────────────
C_RESET=$'\033[0m'; C_CYAN=$'\033[1;36m'; C_DIM=$'\033[1;90m'
C_YEL=$'\033[1;33m'; C_GRN=$'\033[1;32m'; C_MAG=$'\033[1;35m'
PHASE_N=0
phase() { PHASE_N=$((PHASE_N+1)); printf '\n%s[%d/8] %s%s\n' "$C_MAG" "$PHASE_N" "$1" "$C_RESET"; }
log()   { printf '%s  ›%s %s\n' "$C_CYAN" "$C_RESET" "$1"; }
skip()  { printf '%s  ·%s %s\n' "$C_DIM" "$C_RESET" "$1"; }
ok()    { printf '%s  ✓%s %s\n' "$C_GRN" "$C_RESET" "$1"; }
run()   { if $DRY_RUN; then printf '%s  ~%s would %s\n' "$C_YEL" "$C_RESET" "$*"; else "$@"; fi; }

banner() {
  printf '%s' "$C_CYAN"
  cat <<'EOF'
  ┌──────────────────────────────────────────┐
  │   dotfiles · install                      │
  └──────────────────────────────────────────┘
EOF
  printf '%s' "$C_RESET"
  if $DRY_RUN; then printf '%s  (dry-run — nothing will change)%s\n' "$C_YEL" "$C_RESET"; fi
}

# Manual follow-ups accumulated during the run, printed in the final summary.
# Each entry: a title line, then step lines prefixed with a tab. Steps are
# joined with a literal '\n' marker and split at render time.
TODOS=()
todo() { TODOS+=("$1"); }

banner

# link SRC -> DEST, backing up any existing different file/link first
link() {
  local src="$1" dest="$2"
  if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
    skip "$dest (already linked)"
    return
  fi
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    run mkdir -p "$BACKUP_DIR"
    run mv "$dest" "$BACKUP_DIR/"
    log "backed up $dest -> $BACKUP_DIR/"
  fi
  run mkdir -p "$(dirname "$dest")"
  run ln -s "$src" "$dest"
  log "linked $dest"
}

# ── 1. Homebrew ─────────────────────────────────────────────────────
phase "Homebrew"
if ! command -v brew >/dev/null 2>&1; then
  log "installing Homebrew"
  run /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
else
  skip "Homebrew (present)"
fi
eval "$(brew shellenv 2>/dev/null || true)"

# ── 2. Brew bundle ──────────────────────────────────────────────────
phase "Brew bundle (packages, casks, AI CLIs)"
# Homebrew 6+ refuses third-party taps unless trusted (when
# HOMEBREW_REQUIRE_TAP_TRUST is set — the default in clean environments).
# Trust our known taps first so `brew bundle` doesn't abort on them.
# `brew trust` is a no-op on Homebrew versions without the subcommand.
for t in gentleman-programming/tap anomalyco/tap; do
  run brew tap "$t" >/dev/null 2>&1 || true
  run brew trust "$t" >/dev/null 2>&1 || true
done
run brew bundle --file="$DOTFILES_DIR/Brewfile"

# node@22 is keg-only — put it on PATH now so the AI layer (npm/npx) works
# in THIS process, same as ~/.zshrc does for interactive shells.
if [ -d "$(brew --prefix)/opt/node@22/bin" ]; then
  export PATH="$(brew --prefix)/opt/node@22/bin:$PATH"
fi

# ── 3. Symlinks ─────────────────────────────────────────────────────
phase "Linking configs"
link "$DOTFILES_DIR/shell/.zshrc"              "$HOME/.zshrc"
link "$DOTFILES_DIR/shell/.zprofile"           "$HOME/.zprofile"
link "$DOTFILES_DIR/git/.gitconfig"            "$HOME/.gitconfig"
link "$DOTFILES_DIR/git/.gitignore_global"     "$HOME/.gitignore_global"
link "$DOTFILES_DIR/gh/config.yml"             "$HOME/.config/gh/config.yml"
link "$DOTFILES_DIR/ssh/config"                "$HOME/.ssh/config"
link "$DOTFILES_DIR/terminal/herdr/config.toml" "$HOME/.config/herdr/config.toml"
link "$DOTFILES_DIR/ai/claude/ccstatusline/settings.json" "$HOME/.config/ccstatusline/settings.json"

# gentle-shell extensions that enforce the skills ~/AGENTS.md requires. gentle-shell
# loads every *.ts in its agent extensions folder; the *-lib folders hold their logic.
GS_EXT="$HOME/.gentle-shell/agent/extensions"
if [ -d "$HOME/.gentle-shell/agent" ]; then
  for entry in pr-skills-guard.ts pr-gate-lib skill-gates.ts skill-gates-lib; do
    link "$DOTFILES_DIR/ai/gentle-shell/extensions/$entry" "$GS_EXT/$entry"
  done
else
  skip "gentle-shell extensions (gentle-shell not installed)"
  todo "Link the gentle-shell skill guards once gentle-shell is installed¦re-run: ${C_CYAN}./install.sh${C_RESET}"
fi

if [ "$OS" = "Darwin" ]; then
  VS="$HOME/Library/Application Support/Code/User"
  link "$DOTFILES_DIR/editor/vscode/settings.json"    "$VS/settings.json"
  link "$DOTFILES_DIR/editor/vscode/keybindings.json" "$VS/keybindings.json"
fi

# ── 4. VSCode extensions ────────────────────────────────────────────
phase "VSCode extensions"
if command -v code >/dev/null 2>&1; then
  installed="$(code --list-extensions 2>/dev/null || true)"
  while IFS= read -r ext; do
    if [ -z "$ext" ]; then continue; fi
    if printf '%s\n' "$installed" | grep -qx "$ext"; then
      skip "ext $ext"
    else
      run code --install-extension "$ext"
    fi
  done < "$DOTFILES_DIR/editor/vscode/extensions.txt"
else
  skip "vscode extensions (code CLI not found)"
fi

# ── 5. AI layer ─────────────────────────────────────────────────────
phase "AI layer (gentle-ai, agents, skills, plugins)"
if [ -x "$DOTFILES_DIR/ai/install-ai.sh" ]; then
  # install-ai.sh appends its own follow-ups to TODO_FILE so they land here.
  AI_TODO_FILE="$(mktemp)"
  run env TODO_FILE="$AI_TODO_FILE" "$DOTFILES_DIR/ai/install-ai.sh"
  if [ -s "$AI_TODO_FILE" ]; then
    while IFS= read -r line; do [ -n "$line" ] && todo "$line"; done < "$AI_TODO_FILE"
  fi
  rm -f "$AI_TODO_FILE"
else
  skip "AI layer (ai/install-ai.sh not executable)"
fi

# ── 6. atuin history import ─────────────────────────────────────────
phase "Shell history (atuin import)"
# atuin init makes autosuggestions read atuin's DB, not ~/.zsh_history.
# Import once so suggestions aren't empty. Safe to re-run.
if command -v atuin >/dev/null 2>&1; then
  run atuin import auto || true
  ok "history imported into atuin"
else
  skip "atuin (not installed)"
fi

# ── 7. Machine-local secrets file ───────────────────────────────────
phase "Machine-local secrets"
if [ ! -f "$HOME/.zshrc.local" ]; then
  run cp "$DOTFILES_DIR/shell/.zshrc.local.example" "$HOME/.zshrc.local"
  ok "created ~/.zshrc.local"
  todo "Add machine-local secrets — OPTIONAL, only if you need them¦open it: ${C_CYAN}\${EDITOR:-nano} ~/.zshrc.local${C_RESET} (already created, gitignored)¦NPM_TOKEN: for private npm packages — get one at ${C_CYAN}npmjs.com → Access Tokens${C_RESET}, then add ${C_CYAN}export NPM_TOKEN=\"...\"${C_RESET}¦skip this if you don't publish/install private packages¦reload after editing: ${C_CYAN}exec zsh${C_RESET}"
else
  skip "~/.zshrc.local (exists)"
fi

# Always-relevant manual steps

# Clipboard command for the SSH-key step. pbcopy is macOS-only; on Linux it
# depends on the session (wl-copy under Wayland, xclip under X11) and may not
# be installed at all — so fall back to printing the key for manual copy.
if [ "$OS" = "Darwin" ]; then
  CLIP_CMD="pbcopy < ~/.ssh/id_ed25519.pub"
elif command -v wl-copy >/dev/null 2>&1; then
  CLIP_CMD="wl-copy < ~/.ssh/id_ed25519.pub"
elif command -v xclip >/dev/null 2>&1; then
  CLIP_CMD="xclip -sel clip < ~/.ssh/id_ed25519.pub"
else
  CLIP_CMD="bat ~/.ssh/id_ed25519.pub   (no clipboard tool — copy it by hand)"
fi

if ! ssh -T git@github.com 2>&1 | grep -q "successfully authenticated"; then
  todo "Set up your SSH key for GitHub¦generate: ${C_CYAN}ssh-keygen -t ed25519 -C \"pedrovillarreal@gmail.com\"${C_RESET}¦copy it: ${C_CYAN}${CLIP_CMD}${C_RESET}¦paste into GitHub → Settings → SSH keys¦verify: ${C_CYAN}ssh -T git@github.com${C_RESET}"
fi
if command -v gh >/dev/null 2>&1 && ! gh auth status >/dev/null 2>&1; then
  todo "Authenticate the GitHub CLI¦run ${C_CYAN}gh auth login${C_RESET}¦choose GitHub.com → SSH → your key"
fi
if [ "$OS" = "Darwin" ]; then
  todo "Apply macOS system defaults (optional)¦run ${C_CYAN}./macos.sh${C_RESET}¦sets Dock, Finder, key repeat, screenshots — some need a logout"
fi

# ── 8. Summary ──────────────────────────────────────────────────────
phase "Done"
printf '\n%s' "$C_GRN"
cat <<'EOF'
  ┌──────────────────────────────────────────┐
  │   ✓ install complete                      │
  └──────────────────────────────────────────┘
EOF
printf '%s' "$C_RESET"

if [ "${#TODOS[@]}" -gt 0 ]; then
  printf '\n%s  Manual steps left for you:%s\n' "$C_YEL" "$C_RESET"
  i=0
  for entry in "${TODOS[@]}"; do
    i=$((i+1))
    first=1
    # Split on the ¦ separator, one part per line.
    while IFS= read -r part; do
      if [ "$first" = 1 ]; then
        printf '\n   %s%d.%s %b\n' "$C_YEL" "$i" "$C_RESET" "$part"
        first=0
      else
        printf '      %s→%s %b\n' "$C_DIM" "$C_RESET" "$part"
      fi
    done <<EOF
$(printf '%s' "$entry" | tr '¦' '\n')
EOF
  done
  printf '\n%s  Everything else is installed and configured.%s\n' "$C_DIM" "$C_RESET"
else
  printf '\n%s  Nothing left to do — fully configured.%s\n' "$C_GRN" "$C_RESET"
fi
printf '\n%s  Restart your shell:%s exec zsh\n\n' "$C_CYAN" "$C_RESET"
