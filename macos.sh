#!/usr/bin/env bash
# macos.sh — macOS system defaults. Run once, deliberately (not from install.sh).

set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "macos.sh is macOS-only — skipping."
  exit 0
fi

echo "==> applying macOS defaults"

# Keyboard — fast key repeat (good for vim/herdr navigation)
defaults write NSGlobalDomain KeyRepeat -int 2
defaults write NSGlobalDomain InitialKeyRepeat -int 15
defaults write NSGlobalDomain ApplePressAndHoldEnabled -bool false

# Finder — show extensions, path bar, status bar, POSIX path in title
defaults write NSGlobalDomain AppleShowAllExtensions -bool true
defaults write com.apple.finder ShowPathbar -bool true
defaults write com.apple.finder ShowStatusBar -bool true
defaults write com.apple.finder _FXShowPosixPathInTitle -bool true

# Dock — autohide, faster
defaults write com.apple.dock autohide -bool true
defaults write com.apple.dock autohide-delay -float 0
defaults write com.apple.dock show-recents -bool false

# Screenshots — to ~/Screenshots as PNG
mkdir -p "$HOME/Screenshots"
defaults write com.apple.screencapture location -string "$HOME/Screenshots"
defaults write com.apple.screencapture type -string "png"

killall Finder Dock 2>/dev/null || true
echo "==> done (some changes need a logout/restart)"
