.PHONY: install dry-run update brew-dump macos test test-guards

install:   ## Run the installer
	./install.sh

dry-run:   ## Show what install would do, change nothing
	./install.sh --dry-run

update:    ## Update brew packages and skills
	brew update && brew upgrade && brew bundle --file=./Brewfile
	npx skills update || true

brew-dump: ## Regenerate Brewfile from current system
	brew bundle dump --force --file=./Brewfile

macos:     ## Apply macOS system defaults
	./macos.sh

test:      ## Build+run isolated Docker test (Linux)
	docker build -f test/Dockerfile -t dotfiles-test .
	docker run --rm dotfiles-test /repo/test/verify.sh

test-guards: ## Unit tests of the gentle-shell guards
	cd ai/gentle-shell/extensions && node --test skill-gates-lib/gates.test.mjs pr-gate-lib/gate.test.mjs
