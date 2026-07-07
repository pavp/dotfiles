# AI layer

**Orchestrated, not vendored.** gentle-ai configures every agent (persona,
memory, SDD, skills, MCP). We don't version what it generates. What we DO own
is `AGENTS.md` — the single, agent-agnostic source of truth for our own rules.

## Single source of truth: `AGENTS.md`

`ai/AGENTS.md` holds your personal instructions, once, in an agent-neutral
format (the open AGENTS.md standard). Every agent references it — you edit one
file and it propagates.

**Hybrid distribution — reference where possible, copy only if forced:**

| Agent | How it gets AGENTS.md | Mechanism |
| --- | --- | --- |
| Claude Code | `@import` line prepended to `~/.claude/CLAUDE.md` | reference |
| OpenCode | symlink `~/.config/opencode/AGENTS.md` → source | reference |
| Pi | via gentle-ai (`gentle-pi` harness) | gentle-ai |
| *future agent* | add one line in `install-ai.sh` | ref or copy |

Referencing (not copying) means: one edit to `ai/AGENTS.md` updates everyone,
zero drift. Copy only for a future agent that supports neither import nor a
path — then `install-ai.sh` copies the file for that agent alone.

## Why reference beats copy here

gentle-ai injects its own blocks into each agent's file (the
`<!-- gentle-ai:* -->` markers). Verified empirically: content ABOVE those
markers survives every `gentle-ai sync`. So:

- Claude: our `@import` sits at the top → survives sync, coexists with gentle-ai.
- Copying our content INTO `CLAUDE.md` would clobber gentle-ai's blocks. Don't.

## Adding a new agent (organic growth)

1. Write nothing new in `AGENTS.md` — it's already the source.
2. In `install-ai.sh`, add one line pointing the new agent's config at `$SOURCE`:
   - reads a path → `ln -s "$SOURCE" ~/.config/<agent>/AGENTS.md`
   - supports import → prepend `@$SOURCE` to its rules file
   - neither → copy `$SOURCE` to its config (accept manual re-sync)
3. Done. The agent now speaks your rules.

## install-ai.sh order

1. Reference `AGENTS.md` from each agent (Claude import, OpenCode symlink)
2. `gentle-ai install` — configures all agents, injects its blocks
3. storywright (npm), pi (npm), skillkit (npx), caveman (Claude plugin)

## Per-agent post-install steps (run inside a project, not global)

- `/sdd-init` — detect stack, activate Strict TDD (first time in a new project)
- `gentle-ai skill-registry refresh` — after installing/removing skills
- Pi gotcha: `pi -ns` skips startup hooks → run the registry refresh manually
