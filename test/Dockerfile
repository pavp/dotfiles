# Isolated dotfiles test — clean Linux image with Homebrew.
# Build:  docker build -f test/Dockerfile -t dotfiles-test .
# Run:    docker run --rm dotfiles-test          (runs install + verify)
FROM homebrew/brew:latest

USER linuxbrew
ENV DOTFILES_DIR=/repo
COPY --chown=linuxbrew:linuxbrew . /repo
WORKDIR /repo

# install + verify run in the SAME runtime environment (not split across a
# cached build layer and runtime, which masked failures).
CMD ["/repo/test/verify.sh"]
