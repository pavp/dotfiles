# Brewfile — clean-slate. Only what the ideal setup needs.
# Cross-platform formulae first; macOS-only casks in the guarded block at the end.
# Install: brew bundle --file=./Brewfile   (Homebrew skips macOS-only casks on Linux)

# ── Taps ────────────────────────────────────────────────────────────
tap "anomalyco/tap"
tap "gentleman-programming/tap"

# ── Shell UX (replaces Warp features lost under herdr) — TESTED live ──
brew "zsh-autosuggestions"
brew "zsh-syntax-highlighting"
brew "starship"                   # prompt
brew "atuin"                      # shell history (run `atuin import auto` once)
brew "fzf"                        # fuzzy finder (Ctrl+T / Alt+C)
brew "fzf-tab"                    # interactive fuzzy Tab completion
brew "zoxide"                     # smart cd

# ── Modern CLI ──────────────────────────────────────────────────────
brew "eza"                        # ls
brew "bat"                        # cat
brew "fd"                         # find
brew "ripgrep"                    # grep
brew "sd"                         # sed
brew "jq"                         # json
brew "git-delta"                  # git diffs

# ── Dev core ────────────────────────────────────────────────────────
brew "git"
brew "gh"
brew "node@22"
brew "pnpm"

# ── Multiplexer ─────────────────────────────────────────────────────
brew "herdr"

# ── AI stack (brew-installable) ─────────────────────────────────────
brew "rtk"                        # homebrew-core — token proxy
brew "gentleman-programming/tap/gentle-ai"
brew "anomalyco/tap/opencode"

# ── macOS-only (casks) — Homebrew skips these on Linux ──────────────
# Homebrew itself omits casks whose `supports_linux?` is false, warning
# "requires macOS" (extend/os/linux/bundle/skipper.rb). No guard needed here.
# claude-code is NOT here on purpose: as a cask it vanished silently on Linux,
# leaving the AI layer configured for a missing agent. ai/install-ai.sh now
# installs it on both platforms via Anthropic's official installer.
cask "warp"                       # cask = macOS only; Linux via .deb/AppImage
cask "visual-studio-code"

# NOT included (dropped legacy): node@16, ruby@3.1, dotnet, python@3.10,
# go, yarn, azure-cli, watchman, zulu JDKs, docker-desktop, gcloud-cli,
# ngrok, react-native-debugger, chruby, ruby-install, etc.
# Add back explicitly only if you actually need them.
