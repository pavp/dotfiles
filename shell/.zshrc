# ── PATH ──────────────────────────────────────────────────────────
# node@22 (keg-only) — the only runtime on PATH
export PATH="$(brew --prefix)/opt/node@22/bin:$PATH"
export PATH="$PATH:$HOME/.local/bin"

# ── Shell plugins (source order matters: highlighting last) ─────────
source "$(brew --prefix)/share/zsh-autosuggestions/zsh-autosuggestions.zsh"

# ── Completions ─────────────────────────────────────────────────────
autoload -Uz compinit && compinit

# ── Tool init ───────────────────────────────────────────────────────
eval "$(starship init zsh)"
eval "$(zoxide init zsh)"
eval "$(atuin init zsh)"

# fzf: Ctrl+T (files) and Alt+C (cd). NOT completion.zsh — that steals Tab
# from fzf-tab. Ctrl+R is handled by atuin above.
[ -f "$(brew --prefix)/opt/fzf/shell/key-bindings.zsh" ] && source "$(brew --prefix)/opt/fzf/shell/key-bindings.zsh"

# fzf-tab: interactive fuzzy Tab completion. MUST load LAST of the
# completion setup (after compinit and after fzf keybindings) so it wins
# the Tab key, but BEFORE syntax-highlighting.
source "$(brew --prefix)/opt/fzf-tab/share/fzf-tab/fzf-tab.zsh"

# ── Aliases ─────────────────────────────────────────────────────────
alias ls='eza'
alias ll='eza -la'
alias cat='bat'

# ── Syntax highlighting (MUST be sourced last) ──────────────────────
source "$(brew --prefix)/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh"

# ── Machine-local secrets (gitignored, never committed) ─────────────
[ -f "$HOME/.zshrc.local" ] && source "$HOME/.zshrc.local"
