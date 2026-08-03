#!/usr/bin/env bash
# install-ai.sh — AI tooling that brew can't handle (npm/npx/marketplace).
# Brew-installable AI tools (rtk, gentle-ai, opencode) live in the Brewfile.
# claude-code is installed here instead — its cask is macOS-only (see below).
# Each step checks presence before installing (idempotent).

set -uo pipefail

# Unattended: close stdin for the whole script. An installer must NEVER block
# waiting for keyboard input — a stray prompt (engram allowlist y/N, an npx
# "Ok to proceed?", a CLI login) would hang `make test`/CI forever. With stdin
# at EOF, any prompt reads EOF and takes its default (or aborts) instead of
# waiting. Non-interactive flags (--oauth, -y) still handle the specific tools;
# this is the safety net for everything, present and future.
exec </dev/null

DOTFILES_DIR="${DOTFILES_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# ── Config ──────────────────────────────────────────────────────────
# Which agents get skills (skillkit + caveman honor these where applicable).
SKILLKIT_AGENTS="-a claude-code -a opencode"

# Which skillkit skills to install. EMPTY array = ALL skills.
# Full catalog: react-component, react-component-patterns, react-hooks,
#   ts-types, ts-function-signatures, ts-module-organization, review-6-lens,
#   review-comments, leave-it-cleaner, clean-comments, clean-names,
#   clean-functions, clean-structure, browser-automation-safety, diagnose-fix,
#   slice-diff, skill-creator, skill-improver
SKILLKIT_SKILLS=(
  react-component
  react-component-patterns
  react-hooks
  ts-types
  ts-function-signatures
  ts-module-organization
  review-6-lens
  review-comments
  leave-it-cleaner
  clean-comments
  clean-names
  clean-functions
  clean-structure
  browser-automation-safety
  diagnose-fix
)

# Colors — defined here so this script is self-contained. When run standalone
# (not sourced from install.sh) the parent's palette isn't set, and `set -u`
# would abort on any ${C_*} used in todo() messages below.
C_RESET=$'\033[0m'; C_CYAN=$'\033[1;36m'; C_DIM=$'\033[1;90m'
C_YEL=$'\033[1;33m'; C_GRN=$'\033[1;32m'; C_MAG=$'\033[1;35m'

log()  { printf '\033[1;36m  ›\033[0m %s\n' "$1"; }
skip() { printf '\033[1;90m  ·\033[0m %s\n' "$1"; }

# Manual follow-ups. If the parent install.sh passed TODO_FILE, append there so
# they land in its final summary; otherwise print locally at the end.
LOCAL_TODOS=()
todo() {
  if [ -n "${TODO_FILE:-}" ]; then printf '%s\n' "$1" >> "$TODO_FILE"
  else LOCAL_TODOS+=("$1"); fi
}

# ── claude-code (official installer) ────────────────────────────────
# NOT in the Brewfile: the `claude-code` cask is macOS-only, so on Linux
# Homebrew skipped it silently and the AI layer below configured a missing
# agent. Anthropic's installer works on macOS and Linux and lands the binary
# in ~/.local/bin (already on PATH via shell/.zshrc). Runs before the config
# steps so the agent exists before we write its instructions.
if command -v claude >/dev/null 2>&1; then
  skip "claude-code (present)"
else
  log "installing claude-code"
  # stdin is at EOF for this whole script (see `exec </dev/null` above), so the
  # installer takes its defaults instead of prompting.
  curl -fsSL https://claude.ai/install.sh | bash \
    || skip "claude-code (install failed — retry manually: curl -fsSL https://claude.ai/install.sh | bash)"
  # Put it on PATH for the REST of this run (npm/pi steps and gentle-ai may
  # look for `claude`). Interactive shells get it from shell/.zshrc.
  [ -d "$HOME/.local/bin" ] && export PATH="$PATH:$HOME/.local/bin"
fi

# ── Agnostic instructions: reference AGENTS.md from each agent ──────
# ai/AGENTS.md is the single source of truth. We REFERENCE it per agent
# (never copy) so one edit propagates everywhere and gentle-ai's injected
# blocks coexist untouched. To add a new agent later: add one line here
# pointing its config at "$SOURCE" (import or symlink, whichever it supports).
SOURCE="$DOTFILES_DIR/ai/AGENTS.md"
IMPORT_LINE="@$SOURCE"

# Claude Code — supports @import. Prepend the import ABOVE gentle-ai's
# blocks (proven to survive `gentle-ai sync`). Add only if not present.
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
mkdir -p "$HOME/.claude"
if [ -f "$CLAUDE_MD" ] && grep -qF "$IMPORT_LINE" "$CLAUDE_MD"; then
  skip "claude import (already references AGENTS.md)"
else
  printf '%s\n\n%s' "$IMPORT_LINE" "$(cat "$CLAUDE_MD" 2>/dev/null)" > "$CLAUDE_MD"
  log "added @import to ~/.claude/CLAUDE.md"
fi

# OpenCode — do NOT symlink ~/.config/opencode/AGENTS.md. gentle-ai OWNS that
# file (injects its gentle-ai:* blocks into it), and a symlink pointing at /repo
# makes gentle-ai's rollback abort ("OriginalPath must be under home"). Instead
# we register our agnostic AGENTS.md via opencode's native `instructions` array
# in opencode.json — same non-destructive pattern as claude settings.json below.
# The actual merge runs AFTER gentle-ai (it owns opencode.json too); see there.

# New agent template (uncomment + adapt when you add one):
#   ln -s "$SOURCE" "$HOME/.config/<agent>/AGENTS.md"     # if it reads a path
#   printf '@%s\n' "$SOURCE" >> "$HOME/.<agent>/rules.md"  # if it supports import

# Claude settings.json — MERGE our own keys (statusLine, theme, model, …) into
# the existing file. gentle-ai merges its keys (persona, permissions, hooks)
# separately, so both coexist. jq merge = our keys win on conflict, everything
# else (gentle-ai's, yours) is preserved. Add more keys to ai/claude/settings.json
# over time — they'll be merged the same way. NOT a symlink (gentle-ai writes here).
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
MINE_SETTINGS="$DOTFILES_DIR/ai/claude/settings.json"
if command -v jq >/dev/null 2>&1 && [ -f "$MINE_SETTINGS" ]; then
  [ -f "$CLAUDE_SETTINGS" ] || echo '{}' > "$CLAUDE_SETTINGS"
  tmp="$(mktemp)"
  if jq -s '.[0] * .[1]' "$CLAUDE_SETTINGS" "$MINE_SETTINGS" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$CLAUDE_SETTINGS"
    log "merged personal keys into ~/.claude/settings.json"
  else
    rm -f "$tmp"; skip "claude settings merge failed (left existing untouched)"
  fi
else
  skip "claude settings merge (jq missing)"
fi

# ── gentle-ai (ecosystem configurator) — runs after the seed ────────
# gentle-ai configures every detected agent (Claude, OpenCode, Pi, …):
# persona, engram memory, SDD workflow, skills, MCP. It INJECTS its blocks
# into each agent's config (the gentle-ai:* markers), layered on the seed.
if command -v gentle-ai >/dev/null 2>&1; then
  log "gentle-ai install (configures all agents)"
  gentle-ai install || true
else
  skip "gentle-ai (not installed — add via Brewfile)"
fi

# OpenCode instructions — register our agnostic AGENTS.md via the native
# `instructions` array in opencode.json. Runs AFTER gentle-ai because gentle-ai
# owns opencode.json; we merge our path in without clobbering its keys. opencode
# combines every `instructions` file with the AGENTS.md gentle-ai manages, so
# both layers coexist. Idempotent: only appends $SOURCE if not already present.
OC_JSON="$HOME/.config/opencode/opencode.json"
mkdir -p "$HOME/.config/opencode"
if command -v jq >/dev/null 2>&1; then
  [ -f "$OC_JSON" ] || echo '{}' > "$OC_JSON"
  if jq -e --arg s "$SOURCE" '(.instructions // []) | index($s)' "$OC_JSON" >/dev/null 2>&1; then
    skip "opencode instructions (already references AGENTS.md)"
  else
    tmp="$(mktemp)"
    if jq --arg s "$SOURCE" '.instructions = ((.instructions // []) + [$s] | unique)' "$OC_JSON" > "$tmp" 2>/dev/null; then
      mv "$tmp" "$OC_JSON"
      log "registered AGENTS.md in opencode.json instructions"
    else
      rm -f "$tmp"; skip "opencode instructions merge failed (left existing untouched)"
    fi
  fi
else
  skip "opencode instructions (jq missing)"
fi

# ── storywright (npm) ───────────────────────────────────────────────
if command -v storywright >/dev/null 2>&1; then
  skip "storywright (present)"
else
  log "installing storywright"
  npm i -g @pavp/storywright && storywright install
fi

# ── pi coding agent (npm) ───────────────────────────────────────────
if command -v pi >/dev/null 2>&1; then
  skip "pi (present)"
else
  log "installing pi"
  npm i -g @earendil-works/pi-coding-agent
fi

# ── gentle-pi (gentle-ai, made-to-measure for the Pi agent) ─────────
# gentle-ai's ecosystem (persona, SDD agents, memory) delivered as global Pi
# runtime assets. Installed via `pi install`, not npm/brew. Idempotent; each
# package is best-effort (|| true) so one failure doesn't abort the AI layer.
# Companions add subagents, intercom, memory, web access, lens, and todo/ask UX.
if command -v pi >/dev/null 2>&1; then
  log "installing gentle-pi + companions (Pi ecosystem)"
  for pkg in \
    gentle-pi \
    pi-subagents-j0k3r \
    pi-intercom \
    gentle-engram \
    pi-web-access \
    pi-lens \
    @juicesharp/rpiv-todo \
    @juicesharp/rpiv-ask-user-question; do
    pi install "npm:$pkg" >/dev/null 2>&1 || skip "gentle-pi pkg $pkg (install failed — retry manually: pi install npm:$pkg)"
  done
else
  skip "gentle-pi (pi not available)"
fi

# ── ccstatusline (npm) — Claude Code status line ────────────────────
# Activated via the statusLine key merged into ~/.claude/settings.json above;
# layout in ai/claude/ccstatusline/settings.json (symlinked by install.sh).
if command -v ccstatusline >/dev/null 2>&1; then
  skip "ccstatusline (present)"
else
  log "installing ccstatusline"
  npm i -g ccstatusline
fi

# ── skillkit (npx skills — PRIVATE repo, needs GitHub auth) ─────────
# pavp/skillkit is private; the skills CLI clones via git, inheriting your
# git/SSH auth. Gate on it: if GitHub isn't reachable for auth, skip and
# leave a precise follow-up instead of failing silently.
build_skillkit_cmd() {
  skill_flags=()
  for s in "${SKILLKIT_SKILLS[@]}"; do skill_flags+=(-s "$s"); done
}
skillkit_todo() {
  build_skillkit_cmd
  # shellcheck disable=SC2086
  todo "Install your private skillkit skills (needs GitHub auth)¦authenticate first: ${C_CYAN}gh auth login${C_RESET}  (and add your SSH key to GitHub)¦then run: ${C_CYAN}npx -y skills add pavp/skillkit ${skill_flags[*]} $SKILLKIT_AGENTS -g -y${C_RESET}"
}
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  log "installing skillkit skills (private repo)"
  build_skillkit_cmd
  # shellcheck disable=SC2086
  # -y/-g: non-interactive, global — else the scope/confirm prompt aborts on
  # the closed stdin and the skills never install.
  if ! npx -y skills add pavp/skillkit "${skill_flags[@]}" $SKILLKIT_AGENTS -g -y; then
    skip "skillkit failed — added to manual steps"
    skillkit_todo
  fi
else
  skip "skillkit (GitHub not authenticated — deferred to manual steps)"
  skillkit_todo
fi

# ── caveman (multi-agent) ───────────────────────────────────────────
# Universal installer: detects every agent on the machine and installs
# caveman for each (claude, opencode, pi, …). Idempotent, needs Node >=18.
# Per-agent alternative: `claude plugin marketplace add JuliusBrussee/caveman
# && claude plugin install caveman@caveman` (Claude only).
log "installing caveman (all agents)"
curl -fsSL https://raw.githubusercontent.com/JuliusBrussee/caveman/main/install.sh | bash || true

# ── frontend-design (skill, agnostic via skills.sh) ─────────────────
# The official Anthropic skill, agent-agnostic (NOT the Claude-only plugin).
log "installing frontend-design skill"
# -y skips the scope/confirm prompts (with stdin closed they'd abort, not
# default, and the skill would silently NOT install). -g = global scope.
npx -y skills add anthropics/skills -s frontend-design -a claude-code -a opencode -g -y || true

# ── context-mode (context optimizer: MCP + hooks, per agent) ────────
# Global install once, then wire each agent.
if ! command -v context-mode >/dev/null 2>&1; then
  log "installing context-mode (global)"
  npm i -g context-mode
else
  skip "context-mode (present)"
fi
# Claude Code: hooks are auto-registered by the plugin — nothing to do here.
if command -v context-mode >/dev/null 2>&1; then
  # OpenCode: add "context-mode" to the plugin[] array in opencode.json.
  # The plugin registers all ctx_* tools + hooks in-process (no stdio MCP child).
  # Merge with jq so we don't clobber gentle-ai's / your own config. Also strip
  # any legacy mcp.context-mode entry — having BOTH registers ZERO tools.
  OC_JSON="$HOME/.config/opencode/opencode.json"
  if command -v jq >/dev/null 2>&1; then
    mkdir -p "$HOME/.config/opencode"
    [ -f "$OC_JSON" ] || printf '{"$schema":"https://opencode.ai/config.json"}\n' > "$OC_JSON"
    tmp="$(mktemp)"
    jq '.plugin = ((.plugin // []) + ["context-mode"] | unique)
        | del(.mcp["context-mode"])' "$OC_JSON" > "$tmp" && mv "$tmp" "$OC_JSON"
    log "registered context-mode plugin in opencode.json"
  else
    skip "opencode context-mode (jq missing — add \"context-mode\" to plugin[] manually)"
  fi

  # Pi Coding Agent: extension + MCP entry (standalone, no OpenClaw needed).
  if command -v pi >/dev/null 2>&1; then
    pi install npm:context-mode 2>/dev/null || true
    PI_MCP="$HOME/.pi/agent/mcp.json"
    if [ ! -f "$PI_MCP" ]; then
      mkdir -p "$HOME/.pi/agent"
      printf '{\n  "mcpServers": {\n    "context-mode": { "command": "context-mode" }\n  }\n}\n' > "$PI_MCP"
      log "created ~/.pi/agent/mcp.json for context-mode"
    else
      skip "~/.pi/agent/mcp.json (exists — add context-mode manually if missing)"
    fi
  fi
fi

# ── context7 (up-to-date library docs: MCP) ─────────────────────────
# --oauth = the IDE handles the auth flow later, so setup does NOT launch the
# blocking device-code login (the "Press Enter to open browser" prompt that
# hangs an unattended install). -y skips confirmation prompts. </dev/null feeds
# EOF to any stray prompt so it aborts instead of waiting forever. Add an API
# key later for higher rate limits (see manual step below).
log "installing context7 (OAuth, auth deferred to IDE)"
npx -y ctx7 setup --claude --opencode --mcp --oauth -y </dev/null 2>/dev/null || true

# ── Manual follow-ups from the AI layer ─────────────────────────────
todo "Finish gentle-ai setup (persona, memory, SDD, per-agent config)¦run ${C_CYAN}gentle-ai${C_RESET}¦follow the interactive steps and pick your agents/components"
todo "Allow engram tools without a per-call prompt (optional)¦run ${C_CYAN}engram setup claude-code${C_RESET} and answer ${C_CYAN}y${C_RESET} to the allowlist question¦or just pick 'allow always' the first time a mem_* tool runs — one time, either way"
todo "Add a context7 API key for higher rate limits (optional)¦run ${C_CYAN}npx ctx7 setup${C_RESET} and authenticate¦add to ~/.zshrc.local: ${C_CYAN}export CONTEXT7_API_KEY=\"...\"${C_RESET}"
todo "Load caveman + context-mode into your agents¦fully quit and reopen Claude / OpenCode / Pi (a running session won't pick them up)"

log "AI layer done"

# When run standalone (no parent summary), print our follow-ups here.
if [ -z "${TODO_FILE:-}" ] && [ "${#LOCAL_TODOS[@]}" -gt 0 ]; then
  printf '\n\033[1;33m  Manual steps from the AI layer:\033[0m\n'
  n=0
  for entry in "${LOCAL_TODOS[@]}"; do
    n=$((n+1)); first=1
    while IFS= read -r part; do
      if [ "$first" = 1 ]; then printf '   \033[1;33m%d.\033[0m %b\n' "$n" "$part"; first=0
      else printf '      \033[1;90m→\033[0m %b\n' "$part"; fi
    done <<EOF
$(printf '%s' "$entry" | tr '¦' '\n')
EOF
  done
fi
