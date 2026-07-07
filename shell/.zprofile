# Homebrew shellenv — sets PATH, MANPATH, etc.
# macOS: /opt/homebrew  ·  Linux: /home/linuxbrew/.linuxbrew
if [ -x /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [ -x /home/linuxbrew/.linuxbrew/bin/brew ]; then
  eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
fi
