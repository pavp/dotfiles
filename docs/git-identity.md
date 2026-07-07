# Git identity & account switching

How this dotfiles handles who you commit as, and how to add work/multi-account
switching later — without ever committing ephemeral company data.

## The principle

Two things are separate and get handled differently:

| Thing | Versioned in dotfiles? | Why |
| --- | --- | --- |
| **Your personal identity** (name/email/key) | ✅ yes | It's always you |
| **The switching mechanism** (`includeIf`) | ✅ yes | It's structural, not a secret |
| **A company identity** (work email/key) | ❌ no | Ephemeral — you may change employers; exposes corp email if the repo is public |

Rule: the *pattern* is versioned, the *company-specific data* lives local.

## Current setup (personal only)

`git/.gitconfig` sets your personal identity as the **global default**:

```ini
[user]
    name = pavp
    email = pedrovillarreal@gmail.com
[core]
    sshCommand = ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes
```

You commit as yourself everywhere. No switching needed. `git push`/`pull` need
your SSH key present — see the README for key generation.

## Adding work identity later (git) — the `includeIf` way

Git can pick a different identity **automatically** based on which folder the
repo is in. Zero manual switching, and the company data never touches the repo.

1. Organize repos by folder, e.g. `~/dev/personal/…` and `~/dev/work/…`.
2. Create `~/.gitconfig-work` **locally** (never commit it):
   ```ini
   [user]
       name = Your Work Name
       email = you@company.com
   [core]
       sshCommand = ssh -i ~/.ssh/id_work -o IdentitiesOnly=yes
   ```
3. Add the conditional include to your **local** git config
   (`~/.gitconfig.local` or directly, not the versioned one):
   ```ini
   [includeIf "gitdir:~/dev/work/"]
       path = ~/.gitconfig-work
   ```
4. Now any repo under `~/dev/work/` commits with the work identity; everything
   else stays personal. Verify with `git config user.email` inside a repo.

Why `includeIf` beats a manual alias: it's automatic, so you can never
accidentally commit to a work repo with your personal email (or vice-versa).

## Switching gh accounts (separate from git identity)

`git` identity ≠ `gh` auth. `gh` holds the GitHub **auth token** for API/PR
operations, and it's not covered by `includeIf`. Switch it with an alias in
`~/.zshrc.local` (local, never committed — see `shell/.zshrc.local.example`):

```sh
alias ghwork='gh auth switch --user <work-user>'
alias ghpersonal='gh auth switch --user <personal-user>'
alias ghwho='gh auth status 2>&1 | grep "Active account: true" -B1 | grep account'
```

Add each account once with `gh auth login`, then flip between them with the
aliases.

## Summary

| Need | Solution | Lives in |
| --- | --- | --- |
| Personal commit identity | `[user]` default in `git/.gitconfig` | dotfiles (versioned) |
| Auto work identity per folder | `includeIf` → `~/.gitconfig-work` | mechanism versioned, data local |
| Switch active gh account | `gh auth switch` alias | `~/.zshrc.local` (local) |
