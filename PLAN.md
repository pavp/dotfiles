# Dotfiles v1 — Execution Plan

> Clean-slate setup. The machine scan is a **reference** for what you actually use — not a source to copy. Every config is written fresh. Brew is the primary installer; anything that can go through brew, does.

## Guiding principles

1. **Clean slate** — no legacy carried over (no Android SDK, Java, Ruby, .NET, yarn, Sourcetree cruft).
2. **Brew first** — Homebrew installs everything that has a formula/cask. `Brewfile` is the heart of the install.
3. **Versioned vs. orchestrated** — shell/git/terminal/editor configs are versioned (written clean). AI tools are orchestrated (installers invoked, not vendored).
4. **No secrets, ever** — tokens/keys never enter the repo. Local-only files hold them.
5. **Idempotent** — `install.sh` runs twice with no damage.
6. **Portable-ready** — runs on macOS now, but written to migrate to Linux cheaply. No hardcoded brew paths, OS detection scaffolded in. See "Portability" below.

## Portability (macOS now, Linux-ready)

You use Linux too. v1 targets macOS but is written so Linux support is a small later step — not a rewrite.

Rules applied from day one:
- **No hardcoded `/opt/homebrew`.** Shell configs use `$(brew --prefix)` so the same `.zshrc` works with macOS (`/opt/homebrew`) and Linux (`/home/linuxbrew/.linuxbrew`).
- **OS detection scaffold** in `install.sh` and `bootstrap.sh`: `case "$(uname -s)" in Darwin) … ;; Linux) … ;; esac`. macOS branch filled now, Linux branch stubbed.
- **Brewfile split-ready**: portable formulae in `Brewfile`, macOS-only GUI in a clearly marked cask section (Linux install will skip casks and use native packages).
- **`macos.sh` guarded**: exits early if not Darwin. A `linux.sh` sibling is stubbed for later.
- **Clipboard abstraction**: README shows `pbcopy` (macOS) and `xclip`/`wl-copy` (Linux) for the SSH pubkey step.

What stays macOS-only until you flip on Linux: Warp (no stable Linux build), `macos.sh` defaults, casks.
What is already cross-platform: zsh stack, git, node/pnpm, all CLIs (eza/bat/fd/rg/etc.), the entire AI layer (npm/npx).

---

## Final structure

```
dotfiles/
├── Brewfile                      # every brew-installable tool (core of the install)
├── bootstrap.sh                  # remote entry: curl | bash → git, clone, install.sh
├── install.sh                    # idempotent orchestrator
├── macos.sh                      # macOS defaults (Dock, Finder, key repeat, screenshots)
├── Makefile                      # entrypoint: make install / update / brew-dump / test
├── README.md                     # updated — includes SSH key generation steps
├── .gitignore                    # repo-level
│
├── test/
│   ├── Dockerfile                # clean Linux image → copy repo → run install.sh
│   └── verify.sh                 # asserts symlinks exist, tools on PATH, idempotent
│
├── shell/
│   ├── .zshrc                    # zsh bare + 6 plugins, node+pnpm only, NO token
│   ├── .zprofile                 # minimal PATH (brew shellenv only)
│   └── .zshrc.local.example      # template for machine-local secrets
│
├── git/
│   ├── .gitconfig                # clean: correct excludesFile, real includes
│   ├── .gitignore_global
│   ├── .gitconfig-personal       # pavp / gmail identity
│   ├── .gitconfig-work           # nextlane identity
│   └── .stCommitMsg              # commit template (or dropped)
│
├── gh/
│   └── config.yml                # prefs only (hosts.yml NEVER)
│
├── ssh/
│   └── config                    # audited — hosts + IdentityFile refs, NO keys
│
├── terminal/
│   └── herdr/
│       └── config.toml           # herdr config (logs/socks excluded)
│
├── editor/
│   └── vscode/
│       ├── settings.json
│       ├── keybindings.json
│       ├── snippets/
│       └── extensions.txt        # code --list-extensions
│
└── ai/
    ├── claude/                   # AUDITED for secrets before commit
    │   ├── CLAUDE.md
    │   ├── RTK.md
    │   ├── settings.json         # sanitized
    │   ├── output-styles/
    │   ├── commands/
    │   ├── agents/
    │   └── hooks/
    └── install-ai.sh             # npm/npx/marketplace pieces brew can't handle
```

---

## File contents (what each will hold)

### `Brewfile`
Written fresh — only what the clean setup needs, grouped:

```ruby
# Taps
tap "anomalyco/tap"
tap "gentleman-programming/tap"

# Shell UX (replaces Warp features lost under herdr) — all TESTED live
brew "zsh-autosuggestions"
brew "zsh-syntax-highlighting"
brew "starship"
brew "atuin"
brew "fzf"
brew "fzf-tab"                     # interactive fuzzy Tab completion
brew "zoxide"

# Modern CLI
brew "eza"
brew "bat"
brew "fd"
brew "ripgrep"
brew "sd"
brew "jq"
brew "git-delta"

# Dev core
brew "git"
brew "gh"
brew "node@22"
brew "pnpm"

# Multiplexer
brew "herdr"

# AI stack (brew-installable)
brew "rtk"
brew "gentleman-programming/tap/gentle-ai"
brew "anomalyco/tap/opencode"
cask "claude-code"

# --- macOS-only (casks) — Linux install skips this block, uses native pkgs ---
cask "warp"                       # no stable Linux build
cask "visual-studio-code"
cask "claude-code"
```

> Everything above the cask block is cross-platform (works on Linux Homebrew too). The cask block is macOS-only and guarded on install.
>
> NOT included (dropped legacy): node@16, ruby@3.1, dotnet, zulu JDKs, yarn, azure-cli, watchman, and other cruft unless you flag them.

### `shell/.zshrc`
**TESTED LIVE 2026-07-06** — this exact structure works inside and outside herdr. The current `~/.zshrc` on the machine is the working template. Load order below is NOT optional — it's what makes fzf-tab work.

Structure (exact order):
1. PATH: `$(brew --prefix)/opt/node@22/bin` + `$HOME/.local/bin` (node@22 keg-only; pnpm comes via brew on PATH already)
2. `source` zsh-autosuggestions
3. `autoload -Uz compinit && compinit`
4. `eval` init: starship, zoxide, atuin
5. fzf **key-bindings.zsh ONLY** (Ctrl+T / Alt+C)
6. `source` **fzf-tab** — path `$(brew --prefix)/opt/fzf-tab/share/fzf-tab/fzf-tab.zsh`
7. aliases: `ls=eza`, `ll=eza -la`, `cat=bat`, git account-switch (`ghpersonal`/`ghwork`/`ghwho`) — **NO token**
8. `source` zsh-syntax-highlighting (**MUST be last**)
9. `[ -f ~/.zshrc.local ] && source ~/.zshrc.local`

**Gotchas learned (do NOT regress these):**
- **fzf-tab must load AFTER fzf key-bindings** or fzf's completion steals the Tab key. Verify with `bindkey | grep '\^I'` → must show `fzf-tab-complete`, not `fzf-completion`.
- **Do NOT source fzf's `completion.zsh`** — it hijacks Tab from fzf-tab. Only `key-bindings.zsh`. Ctrl+R is atuin's.
- **zsh-syntax-highlighting sourced dead last**, always.
- **`$(brew --prefix)`** everywhere, never hardcode `/opt/homebrew` (portability).
- **`atuin init` makes autosuggestions read atuin's DB, not `~/.zsh_history`.** `install.sh` MUST run `atuin import auto` once, or suggestions read an empty DB and show nothing.
- Extra tools added beyond the original 6: **fzf-tab** (interactive fuzzy Tab), **git-delta** (git diffs). Add both to the Brewfile.

### `shell/.zprofile`
Just: `eval "$(/opt/homebrew/bin/brew shellenv)"`. Android SDK lines dropped.

### `shell/.zshrc.local.example`
```zsh
# Copy to ~/.zshrc.local (gitignored). Put machine-local secrets here.
# export NPM_TOKEN="your-token-here"
```

### `git/.gitconfig`
Clean rewrite:
- `[core] excludesFile = ~/.gitignore_global` (fixes the /tmp bug)
- `[init] defaultBranch = main`
- delta as pager/diff
- `[includeIf "gitdir:~/dev/personal/"] path = ~/.gitconfig-personal`
- `[includeIf "gitdir:~/dev/nextlane/"] path = ~/.gitconfig-work`
- (only these two gitdir paths — Documents/ paths dropped as legacy)
- gh credential helper
- NO Sourcetree difftool/mergetool cruft

### `git/.gitconfig-personal` / `-work`
Each: `[user] name/email` + matching `sshCommand`. The identities that were referenced but missing.

### `ai/install-ai.sh`
Idempotent. Only what brew can't:
```sh
# storywright (npm)
npm i -g @pavp/storywright && storywright install
# pi coding agent (npm)
npm i -g @earendil-works/pi-coding-agent
# skillkit (npx skills) — pick skills here
npx skills add pavp/skillkit -a claude-code -a opencode   # -s <skill> to scope
# caveman — TODO: marketplace source unknown, resolve later
# claude plugin marketplace add <url> && claude plugin install caveman
```

### `bootstrap.sh` — remote entry (fresh Mac)
`curl -fsSL <raw-url>/bootstrap.sh | bash`
1. Install Xcode Command Line Tools (gives git) if missing
2. Clone repo to `~/.dotfiles`
3. `exec ~/.dotfiles/install.sh`

### `install.sh` — ordered steps (designed testable)
Testability contract (shapes how it's written):
- `DOTFILES_DIR="${DOTFILES_DIR:-$HOME/.dotfiles}"` — parametrizable, not hardcoded
- `--dry-run` flag — prints what it would do, executes nothing
- Symlinks target `$HOME` — so a container maps to the container's home
- Fully idempotent — safe to run twice (the test asserts this)

**State-check-before-act contract (idempotency done right — never clobber):**
Every action inspects current state BEFORE touching anything:
- **Symlink**: if target already a correct symlink into the repo → skip. If it's a real file or a different link → move it to `$HOME/.dotfiles-backup/<timestamp>/` FIRST, then link. Never overwrite without backup.
- **Brew**: `brew bundle` is already idempotent (installs only what's missing) — covered by design.
- **VSCode extensions**: read `code --list-extensions`, install only the missing ones.
- **npm globals** (storywright, pi): `command -v` / `npm ls -g` check before reinstall.
- **`.zshrc.local`**: create only if absent — never overwrite machine-local secrets.
- Rule of thumb: **backup, never destroy.** Anything displaced is recoverable under `.dotfiles-backup/`.

Steps:
1. Detect OS (`uname`). Install Homebrew if missing (official script — the only non-brew bootstrap)
2. `brew bundle --file="$DOTFILES_DIR/Brewfile"` (Linux branch skips the cask block)
3. Symlink configs → `$HOME` (shell, git, gh, ssh/config, herdr, vscode, claude). **State check each: skip if already correct, back up to `.dotfiles-backup/<timestamp>/` if different, then link.**
4. `code --install-extension` loop — only extensions not already listed
5. Run `ai/install-ai.sh` (each piece checks `command -v` before installing)
6. `atuin import auto` — import `~/.zsh_history` into atuin (else autosuggestions read an empty DB). Skip if already imported.
7. Create `$HOME/.zshrc.local` from `.example` if absent
8. Print reminder: run `./macos.sh` and generate SSH keys (README steps)

### `test/` — isolated testing (Docker, Linux)
`make test` builds `test/Dockerfile` from a clean Linux image, copies the repo in, runs `install.sh`, then `verify.sh`.

`verify.sh` asserts:
- Expected symlinks exist and point into the repo
- Cross-platform tools are on PATH (zsh plugins, starship, git, node, eza, bat, fd, rg)
- **Idempotency**: runs `install.sh` a SECOND time — must exit 0, no breakage
- **Non-clobber**: pre-seeds a fake existing `.zshrc`, runs install, asserts the original landed in `.dotfiles-backup/` (nothing lost)

Scope: Docker runs Linux, so this validates the ~70% cross-platform surface. macOS-only pieces (casks, `macos.sh`) are validated manually on first real run — no macOS VM for v1.

### `macos.sh` — system defaults (run once, manually)
Key repeat fast, Dock autohide, Finder show extensions/path bar, screenshots to a folder. Not auto-run by install.sh — you invoke it deliberately.

### `Makefile` — entrypoint
```make
install:    ./install.sh
update:     brew update && brew upgrade && npx skills update
brew-dump:  brew bundle dump --force --file=./Brewfile
macos:      ./macos.sh
test:       docker build -f test/Dockerfile -t dotfiles-test . && \
            docker run --rm dotfiles-test /repo/test/verify.sh
dry-run:    ./install.sh --dry-run
```

### `README.md` — must include SSH key generation
```sh
ssh-keygen -t ed25519 -C "you@example.com"
pbcopy < ~/.ssh/id_ed25519.pub   # paste into GitHub → Settings → SSH keys
```
Because `ssh/config` references keys that don't exist on a fresh machine.

---

## Security — mandatory before any commit

| Item | Action |
|------|--------|
| `NPM_TOKEN` | Never written to repo. Lives in `~/.zshrc.local`. |
| `gh/hosts.yml` | Never versioned (auth tokens). |
| `~/.ssh/` keys | Never versioned. Only `config` after audit. |
| `~/.claude/settings.json`, `hooks/`, `agents/` | **Audit line-by-line for embedded keys/tokens before commit.** |
| `~/.claude/` runtime | Exclude cache/, logs/, sessions/, projects/, *.bak, *.orig, daemon.log |

---

## Open TODOs (non-blocking)

- **caveman**: marketplace source unknown → placeholder in install-ai.sh.
- **skillkit skills**: which skills to install — parametrized, you pick when running.
- **warp/settings.toml**: currently empty → include only once you customize Warp.
- **.stCommitMsg**: create a template or drop the `commit.template` line.

---

## Method (decided)

- **Symlinks via a hand-written `install.sh`** — no Stow, no bare-repo, no chezmoi.
- Rationale: zero extra dependency, full transparency, right-sized for a single personal machine.
```
