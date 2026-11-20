import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { checkWrite, createReadTracker, installedSkillPath, mayBeGated, normalizePath, gitCommits, includesCode, porcelainPaths, rulesFor, settleReminder, shellWriteTargets, sinceLastUser, sliceReminder } from "./gates.mjs";

const ALL = (skill) => `/skills/${skill}/SKILL.md`;
const NONE = () => null;
const read = (...skills) => new Set(skills);

let n = 0;
const call = (name, args) => ({ type: "message", id: `e${++n}`, message: { role: "assistant", content: [{ type: "toolCall", id: `c${n}`, name, arguments: args }] } });
const result = (entry, isError = false) => ({ type: "message", id: `e${++n}`, message: { role: "toolResult", toolCallId: entry.message.content[0].id, isError } });
const user = (text) => ({ type: "message", id: `e${++n}`, message: { role: "user", content: [{ type: "text", text }] } });
const compaction = () => ({ type: "compaction", id: `e${++n}` });

test("creating a feature document needs slice-plan", () => {
  const out = checkWrite({ path: "/r/odd/tasks/feat.md", isNew: true, read: read(), installed: ALL });
  assert.equal(out.block, true);
  assert.match(out.reason, /`slice-plan`/);
  assert.match(out.reason, /feature document/);
});

test("the pre-check keeps relative and absolute gated paths and drops the rest", () => {
  for (const path of ["odd/tasks/feat.md", "/r/odd/tasks/feat.md", "src/Card.tsx", "Card.jsx", "a.ts", "src/useTodos.js"]) {
    assert.equal(mayBeGated(path), true, path);
  }
  for (const path of ["README.md", "docs/odd/tasks.md", "a.js", "a.json"]) {
    assert.equal(mayBeGated(path), false, path);
  }
});

test("a relative feature document path is gated", () => {
  assert.equal(checkWrite({ path: "odd/tasks/feat.md", isNew: true, read: read(), installed: ALL }).block, true);
});

test("creating a feature document passes once slice-plan was read", () => {
  assert.equal(checkWrite({ path: "/r/odd/tasks/feat.md", isNew: true, read: read("slice-plan"), installed: ALL }).block, false);
});

test("editing an existing feature document is not gated", () => {
  assert.equal(checkWrite({ path: "/r/odd/tasks/feat.md", isNew: false, read: read(), installed: ALL }).block, false);
});

test("markdown outside odd/tasks is not gated", () => {
  assert.equal(checkWrite({ path: "/r/docs/odd/notes.md", isNew: true, read: read(), installed: ALL }).block, false);
  assert.equal(checkWrite({ path: "/r/odd/tasks/sub/x.md", isNew: true, read: read(), installed: ALL }).block, false);
});

test("a .jsx component needs react-component", () => {
  const out = checkWrite({ path: "/r/src/Card.jsx", isNew: true, read: read(), installed: ALL });
  assert.equal(out.block, true);
  assert.match(out.reason, /`react-component`/);
  assert.equal(checkWrite({ path: "/r/src/Card.jsx", isNew: true, read: read("react-component"), installed: ALL }).block, false);
});

test("a .tsx component needs react-component and a ts skill", () => {
  const onlyReact = checkWrite({ path: "/r/src/Card.tsx", isNew: false, read: read("react-component"), installed: ALL });
  assert.equal(onlyReact.block, true);
  assert.match(onlyReact.reason, /`ts-types`/);
  const onlyTs = checkWrite({ path: "/r/src/Card.tsx", isNew: false, read: read("ts-types"), installed: ALL });
  assert.equal(onlyTs.block, true);
  assert.match(onlyTs.reason, /`react-component`/);
  assert.equal(checkWrite({ path: "/r/src/Card.tsx", isNew: false, read: read("react-component", "ts-types"), installed: ALL }).block, false);
});

test("a .tsx write with nothing read names both missing skills at once", () => {
  const out = checkWrite({ path: "/r/src/Card.tsx", isNew: true, read: read(), installed: ALL });
  assert.equal(out.block, true);
  assert.match(out.reason, /`react-component`/);
  assert.match(out.reason, /`ts-types`/);
});

test("a use* hook file needs react-hooks, not react-component", () => {
  const rules = rulesFor("/r/src/useTodos.ts", { isNew: true }).map((r) => r.id);
  assert.deepEqual(rules, ["react-hook", "typescript"]);
  assert.deepEqual(rulesFor("/r/src/useTodos.jsx", { isNew: true }).map((r) => r.id), ["react-hook"]);
  assert.equal(checkWrite({ path: "/r/src/useTodos.ts", isNew: true, read: read("react-hooks", "ts-function-signatures"), installed: ALL }).block, false);
});

test("words starting with use but not a hook name are not hooks", () => {
  assert.deepEqual(rulesFor("/r/src/user.ts", { isNew: true }).map((r) => r.id), ["typescript"]);
  assert.deepEqual(rulesFor("/r/src/useful.js", { isNew: true }).map((r) => r.id), []);
});

test("any one of the three ts skills satisfies a .ts file", () => {
  for (const skill of ["ts-types", "ts-function-signatures", "ts-module-organization"]) {
    assert.equal(checkWrite({ path: "/r/a.ts", isNew: true, read: read(skill), installed: ALL }).block, false, skill);
  }
  for (const path of ["/r/a.mts", "/r/a.cts", "/r/a.d.ts"]) {
    assert.equal(checkWrite({ path, isNew: true, read: read(), installed: ALL }).block, true, path);
  }
});

test("plain js, json and css are not gated", () => {
  for (const path of ["/r/a.js", "/r/a.mjs", "/r/package.json", "/r/a.css"]) {
    assert.equal(checkWrite({ path, isNew: true, read: read(), installed: ALL }).block, false, path);
  }
});

test("a rule whose skills are not installed is skipped", () => {
  assert.equal(checkWrite({ path: "/r/src/Card.tsx", isNew: true, read: read(), installed: NONE }).block, false);
  const onlyTypes = (skill) => (skill === "ts-types" ? "/x/ts-types/SKILL.md" : null);
  const out = checkWrite({ path: "/r/a.ts", isNew: true, read: read(), installed: onlyTypes });
  assert.equal(out.block, true);
  assert.doesNotMatch(out.reason, /ts-function-signatures/);
});

test("installedSkillPath finds a skill under a known root and nothing elsewhere", () => {
  const home = mkdtempSync(join(tmpdir(), "skill-gates-"));
  try {
    mkdirSync(join(home, ".agents/skills/slice-plan"), { recursive: true });
    writeFileSync(join(home, ".agents/skills/slice-plan/SKILL.md"), "x");
    assert.equal(installedSkillPath("slice-plan", home), join(home, ".agents/skills/slice-plan/SKILL.md"));
    assert.equal(installedSkillPath("react-hooks", home), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const SK = (skill) => join(homedir(), ".agents/skills", skill, "SKILL.md");

test("tracker counts a successful read tool call on an installed skill path", () => {
  const c = call("read", { path: SK("slice-plan") });
  assert.deepEqual([...createReadTracker().update([c, result(c)])], ["slice-plan"]);
  const tilde = call("read", { path: "~/.claude/skills/react-hooks/SKILL.md" });
  assert.deepEqual([...createReadTracker().update([tilde, result(tilde)])], ["react-hooks"]);
});

test("tracker counts a shell command that reads several skills", () => {
  const c = call("bash", { command: "cat ~/.agents/skills/ts-types/SKILL.md; head -400 ~/.agents/skills/react-hooks/SKILL.md" });
  assert.deepEqual([...createReadTracker().update([c, result(c)])].sort(), ["react-hooks", "ts-types"]);
});

test("tracker ignores copies, backups, other folders and listings of a SKILL.md", () => {
  const calls = [
    call("read", { path: `${SK("slice-plan")}.bak` }),
    call("read", { path: "/tmp/fake/slice-plan/SKILL.md" }),
    call("bash", { command: "ls -la ~/.agents/skills/slice-plan/SKILL.md" }),
    call("bash", { command: "echo ~/.agents/skills/slice-plan/SKILL.md" }),
  ];
  assert.deepEqual([...createReadTracker().update(calls.flatMap((c) => [c, result(c)]))], []);
});

test("tracker ignores a failed read and a read with no result yet", () => {
  const failed = call("read", { path: SK("slice-plan") });
  const open = call("read", { path: SK("react-hooks") });
  assert.deepEqual([...createReadTracker().update([failed, result(failed, true), open])], []);
});

test("tracker ignores a write whose content names a SKILL.md", () => {
  const c = call("write", { path: "/r/notes.md", content: `see ${SK("slice-plan")}`, command: "" });
  assert.deepEqual([...createReadTracker().update([c, result(c)])], []);
});

test("tracker counts /skill:<name> as Pi stores it, and not a sentence that only mentions it", () => {
  const expanded = user('<skill name="react-component" location="/x/SKILL.md">\nbody\n</skill>\n\nmake it');
  assert.deepEqual([...createReadTracker().update([expanded])], ["react-component"]);
  assert.deepEqual([...createReadTracker().update([user("should I run /skill:slice-plan?")])], []);
});

test("a compaction forgets earlier reads", () => {
  const c = call("read", { path: SK("slice-plan") });
  assert.deepEqual([...createReadTracker().update([c, result(c), compaction()])], []);
});

test("tracker scans incrementally and restarts on a different branch", () => {
  const tracker = createReadTracker();
  const a = call("read", { path: SK("ts-types") });
  const branch = [a, result(a)];
  assert.deepEqual([...tracker.update(branch)], ["ts-types"]);
  const b = call("read", { path: SK("react-hooks") });
  assert.deepEqual([...tracker.update([...branch, b, result(b)])].sort(), ["react-hooks", "ts-types"]);
  assert.deepEqual([...tracker.update([b, result(b)])], ["react-hooks"]);
});

test("tool paths resolve like Pi's: @ is dropped and ~ is home", () => {
  assert.equal(normalizePath("@odd/tasks/new.md", "/r"), "/r/odd/tasks/new.md");
  assert.equal(normalizePath("~/x/odd/tasks/a.md", "/r"), join(homedir(), "x/odd/tasks/a.md"));
  assert.equal(normalizePath("~", "/r"), homedir());
  assert.equal(normalizePath("/abs/a.ts", "/r"), "/abs/a.ts");
});

test("shell redirects, heredocs and tee are write targets", () => {
  assert.deepEqual(shellWriteTargets("echo x > src/a.ts", "/r"), ["/r/src/a.ts"]);
  assert.deepEqual(shellWriteTargets("echo x >>src/a.ts", "/r"), ["/r/src/a.ts"]);
  assert.deepEqual(shellWriteTargets("echo x>src/a.ts", "/r"), ["/r/src/a.ts"]);
  assert.deepEqual(shellWriteTargets("echo x >| src/a.ts", "/r"), ["/r/src/a.ts"]);
  assert.deepEqual(shellWriteTargets("echo x &> src/a.ts", "/r"), ["/r/src/a.ts"]);
  assert.deepEqual(shellWriteTargets("cat <<'EOF' > odd/tasks/f.md\n# F\nEOF", "/r"), ["/r/odd/tasks/f.md"]);
  assert.deepEqual(shellWriteTargets("printf x | tee -a src/Card.tsx src/B.tsx", "/r"), ["/r/src/Card.tsx", "/r/src/B.tsx"]);
});

test("a heredoc body with quotes and > does not hide or invent targets", () => {
  const command = "cat > src/Pill.tsx <<'EOF'\nexport const P = () => <span>don't > stop</span>;\nEOF\necho done > src/b.ts";
  assert.deepEqual(shellWriteTargets(command, "/r"), ["/r/src/Pill.tsx", "/r/src/b.ts"]);
});

test("in-place sed and perl edit existing files only, cp/mv into a directory keep the source name", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-gates-"));
  try {
    mkdirSync(join(dir, "src/lib"), { recursive: true });
    writeFileSync(join(dir, "src/a.ts"), "x");
    writeFileSync(join(dir, "src/useX.js"), "x");
    writeFileSync(join(dir, "README.md"), "x");
    assert.deepEqual(shellWriteTargets("sed -i '' 's/a/b/' src/a.ts", dir), [join(dir, "src/a.ts")]);
    assert.deepEqual(shellWriteTargets("sed -i.bak -e 's/a/b/' src/a.ts", dir), [join(dir, "src/a.ts")]);
    assert.deepEqual(shellWriteTargets("perl -pi -e 's/a/b/' src/useX.js", dir), [join(dir, "src/useX.js")]);
    assert.deepEqual(shellWriteTargets("sed -i '' 's/foo.ts/bar.ts/' README.md", dir), []);
    assert.deepEqual(shellWriteTargets("cp src/a.ts src/lib", dir), [join(dir, "src/lib/a.ts")]);
    assert.deepEqual(shellWriteTargets("cp src/a.ts /tmp/", dir), ["/tmp/a.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(shellWriteTargets("cp src/a.js src/b.ts", "/r"), ["/r/src/b.ts"]);
  assert.deepEqual(shellWriteTargets("mv old.md odd/tasks/new.md", "/r"), ["/r/odd/tasks/new.md"]);
  assert.deepEqual(shellWriteTargets("install -D -m 644 a.js src/c.ts", "/r"), ["/r/src/c.ts"]);
  assert.deepEqual(shellWriteTargets("touch src/Card.tsx", "/r"), ["/r/src/Card.tsx"]);
});

test("shell targets follow cd, wrappers, substitutions and sh -c", () => {
  assert.deepEqual(shellWriteTargets("cd /x/app && echo x > src/a.ts", "/r"), ["/x/app/src/a.ts"]);
  assert.deepEqual(shellWriteTargets("cd sub; FOO=1 sudo tee b.tsx < in", "/r"), ["/r/sub/b.tsx"]);
  assert.deepEqual(shellWriteTargets("cd odd && touch tasks/n.md", "/r"), ["/r/odd/tasks/n.md"]);
  assert.deepEqual(shellWriteTargets("cd ~ && touch odd/tasks/n.md", "/r"), [join(homedir(), "odd/tasks/n.md")]);
  assert.deepEqual(shellWriteTargets("echo $(echo x > a.ts)", "/r"), ["/r/a.ts"]);
  assert.deepEqual(shellWriteTargets("bash -c \"echo x > src/a.ts\"", "/r"), ["/r/src/a.ts"]);
});

test("reads, quoted >, fd redirects and non-gated files are not write targets", () => {
  for (const command of [
    "cat src/a.ts",
    "sed -n '1,20p' src/a.ts",
    "grep -n '>' src/a.ts",
    "rg \">>\" src/App.tsx",
    "node --test 2>&1 | tail -5",
    "echo x >&2",
    "grep -rn foo src/*.tsx > /tmp/out.txt",
    "npx tsc --noEmit > /dev/null",
    "echo x > notes.md",
    "git mv a.ts b.ts",
  ]) {
    assert.deepEqual(shellWriteTargets(command, "/r"), [], command);
  }
});

const say = (text) => ({ type: "message", id: `e${++n}`, message: { role: "assistant", content: [{ type: "text", text }] } });
const ran = (name, args) => { const c = call(name, args); return [c, result(c)]; };

test("sinceLastUser keeps the last typed message and what follows it", () => {
  const first = user("one");
  const second = user("two");
  const after = say("ok");
  assert.deepEqual(sinceLastUser([first, say("x"), second, after]), [second, after]);
});

test("a created feature document gets the slice reminder", () => {
  const out = sliceReminder({ createdDocs: ["/r/odd/tasks/f.md"], installed: ALL });
  assert.match(out, /Slice guard/);
  assert.match(out, /`\/r\/odd\/tasks\/f\.md`/);
  assert.match(out, /Before any implementation/);
  assert.match(out, /`Stacked` or `Chain`/);
  assert.equal(sliceReminder({ createdDocs: [], installed: ALL }), null);
  assert.equal(sliceReminder({ createdDocs: ["/r/odd/tasks/f.md"], installed: NONE }), null);
});


test("no created document and no done claim means no reminder", () => {
  const entries = [user("build it"), ...ran("write", { path: "src/app.js", content: "x" }), say("Working on the router next.")];
  assert.equal(settleReminder({ entries, cwd: "/r", installed: ALL }), null);
});

test("changed code reported done without verify-before-pr gets the verify reminder", () => {
  for (const text of ["Done: the router works.", "Listo, ya quedó implementado.", "T1 is complete."]) {
    const entries = [user("fix it"), ...ran("edit", { path: "src/app.js", edits: [] }), say(text)];
    const out = settleReminder({ entries, cwd: "/r", installed: ALL });
    assert.match(out, /`verify-before-pr`/, text);
  }
});

test("a commit alone, with no code changed in the run, is not a reason to remind", () => {
  const entries = [user("ship"), ...ran("bash", { command: "git add -A && git commit -qm 'fix: x'" }), say("Done.")];
  assert.equal(settleReminder({ entries, cwd: "/r", installed: ALL }), null);
});

test("no verify reminder when verify-before-pr was loaded, only docs changed, or nothing is claimed done", () => {
  const loaded = [user("fix"), ...ran("read", { path: SK("verify-before-pr") }), ...ran("edit", { path: "src/app.js", edits: [] }), say("Done.")];
  assert.equal(settleReminder({ entries: loaded, cwd: "/r", installed: ALL }), null);
  const docs = [user("docs"), ...ran("write", { path: "README.md", content: "x" }), say("Done.")];
  assert.equal(settleReminder({ entries: docs, cwd: "/r", installed: ALL }), null);
  const progress = [user("fix"), ...ran("edit", { path: "src/app.js", edits: [] }), say("Next I will add tests.")];
  assert.equal(settleReminder({ entries: progress, cwd: "/r", installed: ALL }), null);
});

test("a verify-before-pr read before the user's last message does not count", () => {
  const entries = [user("a"), ...ran("read", { path: SK("verify-before-pr") }), say("ok"), user("b"), ...ran("edit", { path: "src/app.js", edits: [] }), say("Done.")];
  assert.match(settleReminder({ entries, cwd: "/r", installed: ALL }), /`verify-before-pr`/);
});

test("a failed write is not changed code", () => {
  const c = call("edit", { path: "src/app.js", edits: [] });
  const entries = [user("fix"), c, result(c, true), say("Done.")];
  assert.equal(settleReminder({ entries, cwd: "/r", installed: ALL }), null);
});

test("the settle reminder is only about verify-before-pr, and an uninstalled skill adds none", () => {
  const entries = [user("go"), ...ran("write", { path: "odd/tasks/f.md", content: "#" }), ...ran("write", { path: "src/a.js", content: "x" }), say("Done.")];
  const out = settleReminder({ entries, cwd: "/r", installed: ALL });
  assert.match(out, /`verify-before-pr`/);
  assert.doesNotMatch(out, /Slice guard/);
  assert.equal(settleReminder({ entries, cwd: "/r", installed: NONE }), null);
});

test("a run that edits code and commits gets the verify reminder even without a done word", () => {
  const entries = [
    user("add /health, commit it, and tell me when it's done"),
    ...ran("edit", { path: "src/server.js", edits: [] }),
    ...ran("bash", { command: "npm test && git add src && git commit -m 'feat: add GET /health endpoint'" }),
    say("`GET /health` now returns {\"ok\":true}, and it's committed as 599ac72 on main."),
  ];
  const out = settleReminder({ entries, cwd: "/r", installed: ALL });
  assert.match(out, /committed it/);
  assert.match(out, /`verify-before-pr`/);
});

test("a docs-only commit, git config commit.* and a grep for 'git commit' do not remind", () => {
  const docs = [user("docs"), ...ran("write", { path: "README.md", content: "x" }), ...ran("bash", { command: "git add README.md && git commit -m 'docs: x'" }), say("Committed.")];
  assert.equal(settleReminder({ entries: docs, cwd: "/r", installed: ALL }), null);
  const config = [user("check"), ...ran("bash", { command: "git config commit.gpgsign" }), say("It is false.")];
  assert.equal(settleReminder({ entries: config, cwd: "/r", installed: ALL }), null);
  const grep = [user("look"), ...ran("bash", { command: 'grep -rn "git commit" .' }), ...ran("write", { path: "src/a.js", content: "x" }), say("Next I will add tests.")];
  assert.equal(settleReminder({ entries: grep, cwd: "/r", installed: ALL }), null);
});

test("git commit with global options or inside sh -c is a commit", () => {
  for (const command of ["git -C /r commit -am x", "git -c user.name=x commit -m y", "bash -c 'git commit -m x'"]) {
    const entries = [user("fix"), ...ran("edit", { path: "src/a.js", edits: [] }), ...ran("bash", { command }), say("Pushed nothing yet.")];
    assert.match(settleReminder({ entries, cwd: "/r", installed: ALL }), /committed it/, command);
  }
});

test("code written through the shell in any language counts as changed", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-gates-"));
  try {
    writeFileSync(join(dir, "app.py"), "x");
    for (const command of ["sed -i '' s/a/b/ app.py", "cat > main.go <<EOF\npackage main\nEOF", "echo x | tee a.js"]) {
      const entries = [user("fix"), ...ran("bash", { command }), say("Done, fixed it.")];
      assert.match(settleReminder({ entries, cwd: dir, installed: ALL }) ?? "", /`verify-before-pr`/, command);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("done claims: negations and unrelated words do not count, more forms do", () => {
  const run = (text) => settleReminder({ entries: [user("fix"), ...ran("edit", { path: "src/a.js", edits: [] }), say(text)], cwd: "/r", installed: ALL });
  for (const text of ["El hecho es que el test aún falla.", "Not ready yet: tests fail.", "No está listo todavía.", "It isn't done, two tests fail."]) {
    assert.equal(run(text), null, text);
  }
  for (const text of ["Terminé el cambio.", "Fixed: the parser now handles x.", "Ya está, funciona.", "Arreglado el parser."]) {
    assert.match(run(text) ?? "", /`verify-before-pr`/, text);
  }
});

test("a steer message mid-run does not cut the run when runStart is given", () => {
  const prompt = user("fix it");
  const entries = [user("old"), say("ok"), prompt, ...ran("edit", { path: "src/a.ts", edits: [] }), ...ran("bash", { command: "git commit -am x" }), user("also rename the readme"), ...ran("edit", { path: "README.md", edits: [] }), say("Renamed.")];
  assert.match(settleReminder({ entries, cwd: "/r", runStart: 3, installed: ALL }), /committed it/);
  assert.match(settleReminder({ entries, cwd: "/r", runStart: 2, installed: ALL }), /committed it/);
});

test("a /skill:verify-before-pr typed in the prompt counts as loaded", () => {
  const entries = [user('<skill name="verify-before-pr" location="/x/SKILL.md">\nbody\n</skill>\n\nfix it'), ...ran("edit", { path: "src/a.js", edits: [] }), say("Done.")];
  assert.equal(settleReminder({ entries, cwd: "/r", installed: ALL }), null);
  assert.equal(settleReminder({ entries, cwd: "/r", runStart: 1, installed: ALL }), null);
});

test("gitCommits describes each commit's content: directory, -a, named paths and a prior git add", () => {
  assert.deepEqual(gitCommits("git commit -m x", "/r"), [{ dir: "/r", all: false, paths: [], add: null }]);
  assert.deepEqual(gitCommits("git commit -am x", "/r"), [{ dir: "/r", all: true, paths: [], add: null }]);
  assert.deepEqual(gitCommits("git add -A && git commit -m x", "/r"), [{ dir: "/r", all: false, paths: [], add: "all" }]);
  assert.deepEqual(gitCommits("git add . && git commit -m x", "/r")[0].add, "all");
  assert.deepEqual(gitCommits("git add -u && git commit -m x", "/r")[0].add, "tracked");
  assert.deepEqual(gitCommits("git add n.md docs/a.md && git commit -m x", "/r")[0].add, ["n.md", "docs/a.md"]);
  assert.deepEqual(gitCommits("git commit -m x -- a.js b.js", "/r")[0].paths, ["a.js", "b.js"]);
  assert.deepEqual(gitCommits("git commit -m 'msg' a.js", "/r")[0].paths, ["a.js"]);
  assert.deepEqual(gitCommits("git commit -sam msg", "/r")[0], { dir: "/r", all: true, paths: [], add: null });
  assert.deepEqual(gitCommits("git commit --amend --no-edit", "/r")[0], { dir: "/r", all: false, paths: [], add: null });
  assert.deepEqual(gitCommits("git commit -uall -m x", "/r")[0].all, false);
  assert.deepEqual(gitCommits("cd app && git -C sub commit -m x", "/r")[0].dir, "/r/app/sub");
  assert.equal(gitCommits("bash -c 'git commit -m x'", "/r").length, 1);
  for (const command of ["git config commit.gpgsign", 'grep -rn "git commit" .', "echo git commit", "git log --grep commit", "git commit-tree HEAD^{tree}"]) {
    assert.deepEqual(gitCommits(command, "/r"), [], command);
  }
});

test("porcelainPaths reads NUL-separated status, taking a rename's new path", () => {
  assert.deepEqual(porcelainPaths(" M a.js\0?? my notes.md\0R  new.ts\0old.ts\0A  docs/ñandú.md\0"), ["a.js", "my notes.md", "new.ts", "docs/ñandú.md"]);
  assert.deepEqual(porcelainPaths(""), []);
});

test("includesCode is false only for prose files", () => {
  assert.equal(includesCode(["README.md", "odd/tasks/f.md", "notes.txt"]), false);
  assert.equal(includesCode(["README.md", "src/a.js"]), true);
  assert.equal(includesCode([]), false);
});

test("committedCode makes a commit of earlier-written code a reason to remind", () => {
  const entries = [user("ya lo probé, súbelo y mergea"), ...ran("bash", { command: "git push -u origin feat/x" }), say("Subido.")];
  assert.equal(settleReminder({ entries, cwd: "/r", installed: ALL }), null);
  const commit = [user("ya lo probé, súbelo y mergea"), ...ran("bash", { command: "git commit -m x && git push" }), say("Subido y mergeado.")];
  assert.match(settleReminder({ entries: commit, cwd: "/r", committedCode: true, installed: ALL }), /committed it/);
  assert.equal(settleReminder({ entries: commit, cwd: "/r", committedCode: false, installed: ALL }), null);
});

async function loadExtension(tag) {
  const handlers = {};
  const mod = await import(`../skill-gates.ts?case=${tag}`);
  await mod.default({ on: (ev, fn) => ((handlers[ev] ??= []).push(fn)) });
  return handlers;
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "skill-gates-repo-"));
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  return { repo, git };
}

/** Runs one commit command through the real handlers in `repo` and returns the settle result. */
async function commitRun(repo, tag, command) {
  const handlers = await loadExtension(tag);
  const branch = [];
  const ctx = { cwd: repo, sessionManager: { getBranch: () => branch } };
  await handlers.input[0]({}, ctx);
  branch.push(user("ya lo probé, súbelo"));
  const c = call("bash", { command });
  const id = c.message.content[0].id;
  await handlers.tool_call[0]({ toolName: "bash", toolCallId: id, input: { command } }, ctx);
  execFileSync("bash", ["-c", command], { cwd: repo, stdio: "ignore" });
  await handlers.tool_result[0]({ toolCallId: id, isError: false }, ctx);
  branch.push(c, result(c), say("Subido."));
  return handlers.agent_before_settle[0]({ outcome: "completed", entries: [], continue: false }, ctx);
}

const C = "-c user.email=t@t -c user.name=t";

test("a commit of docs only does not remind, whatever else is pending in the tree", async () => {
  const cases = [
    ["C", (r) => { writeFileSync(join(r.repo, "a.js"), "1"); r.git("add", "a.js"); r.git("commit", "-qm", "base"); writeFileSync(join(r.repo, "a.js"), "2"); writeFileSync(join(r.repo, "n.md"), "x"); }, `git add n.md && git ${C} commit -qm docs`],
    ["D", (r) => { r.git("commit", "-q", "--allow-empty", "-m", "base"); writeFileSync(join(r.repo, "tmp.js"), "x"); writeFileSync(join(r.repo, "n.md"), "x"); }, `git add n.md && git ${C} commit -qm docs`],
    ["E", (r) => { writeFileSync(join(r.repo, "n.md"), "1"); r.git("add", "n.md"); r.git("commit", "-qm", "base"); writeFileSync(join(r.repo, "n.md"), "2"); writeFileSync(join(r.repo, "scratch.js"), "x"); }, `git ${C} commit -qam docs`],
    ["H", (r) => { writeFileSync(join(r.repo, "my notes.md"), "1"); r.git("add", "."); r.git("commit", "-qm", "base"); writeFileSync(join(r.repo, "my notes.md"), "2"); }, `git ${C} commit -qam docs`],
    ["I", (r) => { r.git("commit", "-q", "--allow-empty", "-m", "base"); mkdirSync(join(r.repo, "docs")); writeFileSync(join(r.repo, "docs/ñandú.md"), "x"); r.git("add", "docs"); }, `git ${C} commit -qm docs`],
  ];
  for (const [tag, setup, command] of cases) {
    const r = makeRepo();
    try {
      setup(r);
      assert.equal(await commitRun(r.repo, `docs-${tag}`, command), undefined, tag);
    } finally {
      rmSync(r.repo, { recursive: true, force: true });
    }
  }
});

test("a commit that records code reminds: staged, -a, git add, or named files", async () => {
  const base = (r) => { writeFileSync(join(r.repo, "a.js"), "1"); r.git("add", "a.js"); r.git("commit", "-qm", "base"); writeFileSync(join(r.repo, "a.js"), "2"); };
  const cases = [
    ["staged", (r) => { base(r); r.git("add", "a.js"); }, `git ${C} commit -qm feat`],
    ["all", base, `git ${C} commit -qam feat`],
    ["add", base, `git add -A && git ${C} commit -qm feat`],
    ["F", base, `git ${C} commit -qm feat -- a.js`],
    ["G", base, `git ${C} commit -qm feat a.js`],
    ["first", (r) => { writeFileSync(join(r.repo, "app.js"), "x"); }, `git add -A && git ${C} commit -qm feat`],
  ];
  for (const [tag, setup, command] of cases) {
    const r = makeRepo();
    try {
      setup(r);
      const out = await commitRun(r.repo, `code-${tag}`, command);
      assert.equal(out?.continue, true, tag);
      assert.match(out.entries[0].content, /committed it/, tag);
    } finally {
      rmSync(r.repo, { recursive: true, force: true });
    }
  }
});

test("a slow git is cut off at the deadline without freezing the process and without blocking the call", async () => {
  const bin = mkdtempSync(join(tmpdir(), "skill-gates-git-"));
  const path = process.env.PATH;
  try {
    writeFileSync(join(bin, "git"), "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
    process.env.PATH = `${bin}:${path}`;
    const handlers = await loadExtension("slow");
    const ctx = { cwd: bin, sessionManager: { getBranch: () => [] } };
    let ticks = 0;
    const timer = setInterval(() => ticks++, 100);
    const started = Date.now();
    const out = await handlers.tool_call[0]({ toolName: "bash", toolCallId: "s1", input: { command: "git commit -m x" } }, ctx);
    clearInterval(timer);
    const took = Date.now() - started;
    assert.equal(out, undefined);
    assert.ok(took >= 1900 && took < 3500, `took ${took} ms`);
    assert.ok(ticks >= 10, `event loop ticked ${ticks} times`);
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("the extension reminds when a commit includes code written in an earlier prompt, and not for docs only", async () => {
  const repo = mkdtempSync(join(tmpdir(), "skill-gates-repo-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const drive = async (file, command) => {
      writeFileSync(join(repo, file), "x");
      const handlers = {};
      const mod = await import(`../skill-gates.ts?case=${file}`);
      await mod.default({ on: (ev, fn) => ((handlers[ev] ??= []).push(fn)) });
      const branch = [];
      const ctx = { cwd: repo, sessionManager: { getBranch: () => branch } };
      await handlers.input[0]({}, ctx);
      branch.push(user("ya lo probé, súbelo"));
      const c = call("bash", { command });
      await handlers.tool_call[0]({ toolName: "bash", toolCallId: c.message.content[0].id, input: { command } }, ctx);
      execFileSync("bash", ["-c", command], { cwd: repo, stdio: "ignore" });
      await handlers.tool_result[0]({ toolCallId: c.message.content[0].id, isError: false }, ctx);
      branch.push(c, result(c), say("Subido."));
      return handlers.agent_before_settle[0]({ outcome: "completed", entries: [], continue: false }, ctx);
    };
    const code = await drive("app.js", "git add -A && git -c user.email=t@t -c user.name=t commit -qm 'feat: x'");
    assert.equal(code?.continue, true);
    assert.match(code.entries[0].content, /committed it/);
    const docs = await drive("NOTES.md", "git add NOTES.md && git -c user.email=t@t -c user.name=t commit -qm 'docs: x'");
    assert.equal(docs, undefined);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
