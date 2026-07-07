# dotfiles

Personal, clean-slate dotfiles for macOS (Linux-ready). Brew-first, symlink-based,
idempotent, backup-safe. AI layer is orchestrated agnostically via gentle-ai +
a single `ai/AGENTS.md` source of truth.

## Quick start (fresh machine)

```sh
# Remote bootstrap: installs git, clones the repo, runs install.sh
curl -fsSL https://raw.githubusercontent.com/pavp/dotfiles/main/bootstrap.sh | bash
```

Or manually:

```sh
git clone git@github.com:pavp/dotfiles.git ~/.dotfiles
cd ~/.dotfiles
make install        # or ./install.sh
make dry-run        # preview without changing anything
```

After install, on macOS:

```sh
make macos          # apply system defaults (Dock, Finder, key repeat, screenshots)
```

## Generate your SSH key (required for GitHub)

The configs reference `~/.ssh/id_ed25519` but **keys are never versioned** —
generate one per machine:

```sh
# 1. Generate an ed25519 key
ssh-keygen -t ed25519 -C "pedrovillarreal@gmail.com"

# 2. Start the agent and add the key
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519

# 3. Copy the public key to the clipboard
pbcopy < ~/.ssh/id_ed25519.pub          # macOS
# xclip -sel clip < ~/.ssh/id_ed25519.pub   # Linux (X11)
# wl-copy   < ~/.ssh/id_ed25519.pub          # Linux (Wayland)

# 4. Paste it into GitHub → Settings → SSH and GPG keys → New SSH key

# 5. Verify
ssh -T git@github.com
```

Until this key exists, `git push`/`pull`/`clone` over SSH will fail — everything
else (identity, delta, aliases) works immediately.

## What's inside

| Path | What |
| --- | --- |
| `Brewfile` | All brew-installable tools (shell UX, CLIs, node, herdr, AI stack, casks) |
| `install.sh` | Idempotent installer: brew bundle, symlinks (backup-safe), extensions, AI layer |
| `bootstrap.sh` | Remote entry point for a fresh machine |
| `macos.sh` | macOS system defaults (run once) |
| `Makefile` | `install` / `dry-run` / `update` / `brew-dump` / `macos` / `test` |
| `shell/` | zsh (bare + autosuggestions, syntax-highlighting, starship, atuin, fzf, fzf-tab, zoxide) |
| `git/` | `.gitconfig` (personal identity, delta, ed25519), `.gitignore_global` |
| `gh/` | gh CLI config (prefs only — `hosts.yml` never versioned) |
| `ssh/` | `config` (hosts + key refs only — no keys) |
| `terminal/herdr/` | herdr multiplexer config |
| `editor/vscode/` | settings, keybindings, extension list |
| `ai/` | `AGENTS.md` (agnostic source of truth) + `install-ai.sh` (gentle-ai, engram, pi + gentle-pi ecosystem, storywright, ccstatusline, skillkit, caveman, context-mode, context7, frontend-design) |
| `test/` | Docker-based isolated install test |

## Shell stack

zsh, no framework. Recovers the terminal features herdr can't inherit from Warp:

- **autosuggestions** (gray, from atuin history) · **syntax-highlighting**
- **starship** prompt · **zoxide** smart cd · **atuin** history search (Ctrl+R)
- **fzf** (Ctrl+T / Alt+C) · **fzf-tab** (interactive fuzzy Tab completion)

> On a fresh install, run `atuin import auto` once (install.sh does this) so
> suggestions read your real history, not an empty atuin DB.

## Git identity

Everything uses your personal identity (global default). Work/company identity is
**intentionally not versioned** (it's ephemeral). To add work identity or gh
account switching later, see **[docs/git-identity.md](docs/git-identity.md)**.

## Security

Never committed (enforced by `.gitignore`): `~/.zshrc.local` (secrets like
`NPM_TOKEN`), `gh/hosts.yml` (auth tokens), SSH private keys, Claude local
settings/logs.

## Testing

```sh
make test           # builds a clean Linux container, runs install.sh + verify.sh
```

Validates symlinks, tools on PATH, idempotency (runs install twice), and
non-clobber (pre-existing files are backed up, not destroyed). Docker runs Linux,
so this covers the cross-platform surface; macOS-only pieces (casks, `macos.sh`)
are validated manually on first run.

The install is **fully unattended**: it never blocks on a prompt. Tools that
need auth use non-interactive flags (context7 `--oauth`, skills `-y -g`), and
`install-ai.sh` closes stdin globally as a safety net, so any stray prompt takes
its default instead of hanging. Anything that genuinely needs a human (GitHub
SSH key, `gh auth`, engram allowlist) is deferred to the manual-steps summary at
the end of the run.

## Portability

macOS now, Linux-ready: no hardcoded brew paths (`$(brew --prefix)`), OS detection
scaffolded, casks in a guarded block Linux skips.

## License

Personal dotfiles — private, not licensed for distribution. Take any idea you
find useful, but this repo isn't published for reuse.
