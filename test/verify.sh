#!/usr/bin/env bash
# verify.sh — assert the install produced a correct, idempotent, non-clobbering result.
set -uo pipefail

DOTFILES_DIR="${DOTFILES_DIR:-/repo}"
fail=0
pass() { printf '\033[1;32m  ok\033[0m %s\n' "$1"; }
bad()  { printf '\033[1;31mFAIL\033[0m %s\n' "$1"; fail=1; }

echo "== running install.sh =="
if "$DOTFILES_DIR/install.sh" >/tmp/install.log 2>&1; then
  pass "install.sh exited 0"
else
  bad "install.sh failed (see below)"; tail -20 /tmp/install.log
fi

echo "== symlinks =="
for pair in \
  "$HOME/.zshrc:$DOTFILES_DIR/shell/.zshrc" \
  "$HOME/.zprofile:$DOTFILES_DIR/shell/.zprofile" \
  "$HOME/.gitconfig:$DOTFILES_DIR/git/.gitconfig" ; do
  dest="${pair%%:*}"; src="${pair##*:}"
  if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then pass "$dest"; else bad "$dest not linked to $src"; fi
done

echo "== cross-platform tools on PATH =="
eval "$(brew shellenv 2>/dev/null || true)"
# node@22 is keg-only — add it like .zshrc does before checking.
export PATH="$(brew --prefix)/opt/node@22/bin:$PATH"
for t in starship zoxide atuin fzf eza bat fd rg git node; do
  if command -v "$t" >/dev/null 2>&1; then pass "$t"; else bad "$t missing"; fi
done

echo "== idempotency (second run must exit 0) =="
if "$DOTFILES_DIR/install.sh" >/dev/null 2>&1; then pass "second run clean"; else bad "second run failed"; fi

echo "== non-clobber (existing file gets backed up, not destroyed) =="
marker="CANARY-$$"
echo "$marker" > "$HOME/.zshrc.canary-test"
# simulate: a real file where a symlink should go
rm -f "$HOME/.gitignore_global"
echo "$marker" > "$HOME/.gitignore_global"
"$DOTFILES_DIR/install.sh" >/dev/null 2>&1 || true
if grep -rq "$marker" "$HOME/.dotfiles-backup/" 2>/dev/null; then
  pass "pre-existing file preserved in backup"
else
  bad "pre-existing file was NOT backed up"
fi
rm -f "$HOME/.zshrc.canary-test"

echo
if [ "$fail" = 0 ]; then echo "ALL CHECKS PASSED"; else echo "SOME CHECKS FAILED"; fi
exit "$fail"
