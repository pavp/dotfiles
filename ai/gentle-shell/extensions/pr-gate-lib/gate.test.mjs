import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCommand } from "./gate.mjs";

const dir = mkdtempSync(join(tmpdir(), "pr-gate-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = (name, text) => { writeFileSync(join(dir, name), text); return name; };
const EVIDENCE = "## Evidence\n<!-- evidence:start -->\nChecked.\n<!-- evidence:end -->\n";
const check = (command) => checkCommand(command, { cwd: dir });

test("commands that do not open or describe a PR pass", () => {
  for (const c of ["git status", "gh pr view 12", "gh pr list", "gh pr merge 12 --merge", "gh pr edit 12 --add-label bug", "gh pr checks 3", "echo gh pr create"])
    assert.equal(check(c).block, false, c);
});

test("gh pr create without evidence is blocked with the instruction", () => {
  const r = check(`gh pr create --base main --title t --body-file ${file("plain.md", "## Summary\nx\n")}`);
  assert.equal(r.block, true);
  assert.match(r.reason, /verify-before-pr/);
  assert.match(r.reason, /pr-description/);
  assert.match(r.reason, /evidence:start/);
});

test("gh pr create with the evidence markers in its body file passes", () => {
  assert.equal(check(`cd ${dir} && gh pr create --title t --body-file ${file("ok.md", EVIDENCE)}`).block, false);
  assert.equal(check(`gh pr create -t t -F ${join(dir, "ok.md")}`).block, false);
});

test("an inline body is checked too", () => {
  assert.equal(check(`gh pr create -t t --body "no evidence here"`).block, true);
  assert.equal(check(`gh pr create -t t -b "<!-- evidence:start -->x<!-- evidence:end -->"`).block, false);
});

test("an explicit skip marker with a reason passes; without a reason it does not", () => {
  assert.equal(check(`gh pr create -t t --body-file ${file("docs.md", "<!-- evidence:skip: docs-only -->\nx")}`).block, false);
  assert.equal(check(`gh pr create -t t --body-file ${file("bare.md", "<!-- evidence:skip: -->\nx")}`).block, true);
});

test("body edits are gated, other edits are not", () => {
  assert.equal(check(`gh pr edit 5 --body-file ${file("e.md", "x")}`).block, true);
  assert.equal(check(`gh pr edit 5 --body-file ${join(dir, "ok.md")} --attach './a.png#a'`).block, false);
  assert.equal(check(`gh pr edit 5 --title "new title"`).block, false);
});

test("gh flags before pr, wrappers and absolute paths are still recognized", () => {
  for (const c of [
    "gh -R o/r pr create -t t --fill",
    "sh -c 'gh pr create --fill'",
    "bash -lc \"cd /x && gh pr create --fill\"",
    "env GH_TOKEN=x gh pr create --fill",
    "command gh pr create --fill",
    "/opt/homebrew/bin/gh pr create --fill",
    "x=$(gh pr create --fill)",
    "git push -u origin b && gh pr create --fill",
  ]) assert.equal(check(c).block, true, c);
});

test("--web leaves the body to the person and passes", () => {
  assert.equal(check("gh pr create --web").block, false);
});

test("other ways to open a PR are blocked", () => {
  for (const c of [
    "gh api repos/o/r/pulls -f title=t -f head=b -f base=main",
    "gh api -X POST repos/o/r/pulls --input body.json",
    "gh api graphql -f query='mutation { createPullRequest(input: {}) { pullRequest { url } } }'",
    "hub pull-request -m t",
  ]) assert.equal(check(c).block, true, c);
  assert.equal(check("gh api repos/o/r/pulls/12/comments").block, false);
  assert.equal(check("gh api repos/o/r/pulls").block, false);
});

test("a body file that cannot be read blocks and says which", () => {
  const r = check("gh pr create -t t --body-file missing.md");
  assert.equal(r.block, true);
  assert.match(r.reason, /missing\.md/);
});

test("searches and quoted mentions of PR commands pass", () => {
  for (const c of [`rg 'gh pr create' ~/.agents`, `rg "gh pr create" -n src`, `grep -rn 'gh pr edit --body' docs`, `grep -n "gh pr create" README.md`,
    `git log --grep="gh pr create"`, `cat SKILL.md | grep "gh pr create"`, `git diff -- 'gh pr create'`, `printf '%s\\n' 'gh pr create --fill'`,
    "cat > script.sh <<'EOF'\ngh pr create --fill\nEOF", `git commit -m "run gh pr create later"`,
    "gh api repos/o/r/pulls -X GET -f state=open", "gh api repos/o/r/pulls --paginate -X GET -F per_page=100", "gh api repos/o/r/pulls/12/comments -f body=x"])
    assert.equal(check(c).block, false, c);
});

test("line continuations are joined", () => {
  assert.equal(check(`gh pr create --title t \\\n  --body-file ${join(dir, "ok.md")}`).block, false);
  assert.equal(check("gh pr create \\\n  --web").block, false);
});

test("aliases, joined flags, wrappers and description rewrites are gated", () => {
  for (const c of ["gh pr new --fill", "gh pr edit 12 -bx", "gh api repos/o/r/pulls/ -f title=t -f head=b -f base=main", "gh api /repos/o/r/pulls -fhead=b",
    "gh api repos/o/r/pulls/12 -X PATCH -f body=x", "gh api graphql -f query='mutation{updatePullRequest(input:{body:\"x\"}){clientMutationId}}'",
    "hub -C x pull-request -m t", "timeout 60 gh pr create --fill", "if true; then gh pr create --fill; fi",
    "gh pr create --title 'add --web docs' --fill", "gh pr create --title 'fix -w flag' --body x"])
    assert.equal(check(c).block, true, c);
});

test("markers count only inside the body", () => {
  assert.equal(check("git commit -m '<!-- evidence:skip: n/a -->' && gh pr create --fill").block, true);
  assert.equal(check(`gh pr create --title "<!-- evidence:start --><!-- evidence:end -->" --body-file ${join(dir, "plain.md")}`).block, true);
});

test("a heredoc body in the command is checked", () => {
  assert.equal(check(`gh pr create -t t --body-file - <<'EOF'\n${EVIDENCE}EOF`).block, false);
  assert.equal(check(`gh pr create -t t --body-file - <<'EOF'\nno markers\nEOF`).block, true);
});

test("a heredoc inside $() in --body is checked", () => {
  assert.equal(check(`gh pr create -t t --body "$(cat <<'EOF'\n${EVIDENCE}EOF\n)"`).block, false);
  assert.equal(check(`gh pr create -t t --body "$(cat <<'EOF'\nno markers\nEOF\n)"`).block, true);
});

test("an apostrophe in a commit heredoc does not hide a later PR command", () => {
  assert.equal(check(`git commit -m "$(cat <<'EOF'\nfix: don't\nEOF\n)" && gh pr create --fill`).block, true);
  assert.equal(check(`git commit -m "$(cat <<'EOF'\nfix: don't\nEOF\n)"`).block, false);
});

test("sudo is stripped and arithmetic shifts are not heredocs", () => {
  assert.equal(check("sudo gh pr create --fill").block, true);
  assert.equal(check("sudo -u me gh pr create --fill").block, true);
  assert.equal(check("(( n << 1 ))\ngh pr create --fill").block, true);
});

test("a long many-line script is checked quickly", () => {
  const big = "echo a\n".repeat(20000) + "gh pr create --fill";
  const t = Date.now();
  assert.equal(check(big).block, true);
  assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`);
});
