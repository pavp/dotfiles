import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parse } from "../pr-gate-lib/gate.mjs";

const SKILL_ROOTS = [
  ".agents/skills",
  ".claude/skills",
  ".gentle-shell/agent/skills",
  ".pi/agent/skills",
  ".config/agents/skills",
];

const ODD_DOC = /(?:^|\/)odd\/tasks\/[^/]+\.md$/;
const HOOK_FILE = /^use[A-Z0-9][^/]*\.(?:[cm]?[jt]sx?)$/;
const REACT_FILE = /\.(?:tsx|jsx)$/;
const TS_FILE = /\.(?:[cm]?ts|tsx)$/;
const SKILL_PATH = /\/([a-z0-9][a-z0-9-]*)\/SKILL\.md$/;
const SKILL_BLOCK = /<skill name="([a-z0-9][a-z0-9-]*)"/g;
const READERS = new Set(["cat", "head", "tail", "less", "more", "bat", "nl", "sed", "awk"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const REDIR = "\u0001>";

/** Resolves a tool path the way Pi's tools do: a leading `@` is dropped and `~` is the home directory. */
export function normalizePath(raw, cwd) {
  let path = String(raw ?? "");
  if (path.startsWith("@")) path = path.slice(1);
  if (path === "~") path = homedir();
  else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

/**
 * Marks every unquoted output redirect as its own `\u0001>` word followed by its target, outside heredoc bodies,
 * and drops fd duplications (`2>&1`). The shared lexer drops quotes, so a quoted '>' would otherwise look the same.
 */
function markRedirects(src) {
  let out = "", quote = null, pending = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"') { out += c + (src[i + 1] ?? ""); i++; continue; }
      out += c;
      continue;
    }
    if (c === "\\") { out += c + (src[i + 1] ?? ""); i++; continue; }
    if (c === "'" || c === '"') { quote = c; out += c; continue; }
    if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
      const m = /^<<-?[ \t]*(['"]?)([^\s'";&|<>()]+)\1/.exec(src.slice(i));
      if (m) { pending.push(m[2]); out += m[0]; i += m[0].length - 1; continue; }
    }
    if (c === "\n" && pending.length) {
      out += c;
      for (const delim of pending) {
        while (i + 1 < src.length) {
          const end = src.indexOf("\n", i + 1);
          const line = src.slice(i + 1, end < 0 ? src.length : end);
          out += line + (end < 0 ? "" : "\n");
          i = end < 0 ? src.length : end;
          if (line.trim() === delim) break;
        }
      }
      pending = [];
      continue;
    }
    if (c === ">") {
      if (/(?:^|[\s;&|(])(?:\d|&)$/.test(out)) out = out.slice(0, -1);
      let j = i + 1;
      if (src[j] === ">" || src[j] === "|") j++;
      if (src[j] === "&") {
        j++;
        while (j < src.length && /[\d-]/.test(src[j])) j++;
        out += " ";
      } else {
        out += ` ${REDIR} `;
      }
      i = j - 1;
      continue;
    }
    out += c;
  }
  return out;
}

/** Cheap pre-check on the raw tool path, relative or absolute, before any file or session work. */
export function mayBeGated(path) {
  const name = basename(path);
  return ODD_DOC.test(path) || HOOK_FILE.test(name) || REACT_FILE.test(name) || TS_FILE.test(name);
}

const WRAPPERS = new Set(["sudo", "env", "command", "builtin", "nohup", "time", "exec"]);

function commandArgs(argv) {
  let i = 0;
  while (i < argv.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]) || WRAPPERS.has(argv[i]))) i++;
  return argv.slice(i);
}

function operands(args) {
  return args.filter((a) => !a.startsWith("-") && !a.startsWith("<<"));
}

/**
 * Files a shell command writes through its common forms: `>`/`>>` redirects, `tee`, in-place `sed`/`perl`,
 * the destination of `cp`/`mv`/`install`, and `touch`. Relative targets resolve against `cwd`, following
 * `cd` inside the command. Scripts in other interpreters (`node -e`, `python -c`) are not seen.
 */
function allShellWriteTargets(command, cwd) {
  const targets = [];
  const scripts = [{ src: String(command || ""), dir: cwd }];
  for (let s = 0; s < scripts.length && s < 20; s++) {
    let dir = scripts[s].dir;
    const { cmds, subs } = parse(markRedirects(scripts[s].src));
    for (const sub of subs) scripts.push({ src: sub, dir });
    for (const { argv } of cmds) {
      const words = [];
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] !== REDIR) { words.push(argv[i]); continue; }
        const target = argv[++i];
        if (target) targets.push(normalizePath(target, dir));
      }
      const [name, ...rest] = commandArgs(words);
      if (name === "cd") {
        dir = normalizePath(operands(rest)[0] ?? "~", dir);
        continue;
      }
      if (SHELLS.has(name)) {
        const c = rest.indexOf("-c");
        if (c >= 0 && rest[c + 1] !== undefined) scripts.push({ src: rest[c + 1], dir });
        continue;
      }
      const files = operands(rest).map((path) => normalizePath(path, dir));
      const inPlace = rest.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"));
      if (name === "tee" || name === "touch") {
        targets.push(...files);
      } else if ((name === "sed" || name === "perl") && inPlace) {
        targets.push(...files.filter(isFile));
      } else if ((name === "cp" || name === "mv" || name === "install") && files.length > 1) {
        const dest = files[files.length - 1];
        const intoDir = dest.endsWith("/") || isDirectory(dest) || /\/$/.test(operands(rest).at(-1) ?? "");
        if (intoDir) for (const src of files.slice(0, -1)) targets.push(join(dest, basename(src)));
        else targets.push(dest);
      }
    }
  }
  return targets;
}

export function shellWriteTargets(command, cwd) {
  return allShellWriteTargets(command, cwd).filter((path) => mayBeGated(path));
}

/**
 * The AGENTS.md rules that apply to writing `path`. Each rule is met by reading any one of `anyOf`.
 * `isNew` matters only for the slice rule: it fires when a feature document is created, not edited.
 */
export function rulesFor(path, { isNew }) {
  const rules = [];
  const name = basename(path);
  if (ODD_DOC.test(path) && isNew) {
    rules.push({ id: "slice", anyOf: ["slice-plan"], what: "creating a feature document (odd/tasks/*.md)" });
  }
  if (HOOK_FILE.test(name)) {
    rules.push({ id: "react-hook", anyOf: ["react-hooks"], what: `writing the hook file ${name}` });
  } else if (REACT_FILE.test(name)) {
    rules.push({ id: "react-component", anyOf: ["react-component"], what: `writing the component file ${name}` });
  }
  if (TS_FILE.test(name)) {
    rules.push({
      id: "typescript",
      anyOf: ["ts-types", "ts-function-signatures", "ts-module-organization"],
      what: `writing the TypeScript file ${name}`,
    });
  }
  return rules;
}

/** Path of an installed skill's SKILL.md, or null when no known skill root has it. */
export function installedSkillPath(skill, home = homedir()) {
  for (const root of SKILL_ROOTS) {
    const file = join(home, root, skill, "SKILL.md");
    if (existsSync(file)) return file;
  }
  return null;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && part.type === "text" ? part.text : "")).join("\n");
}

/** The skill whose installed SKILL.md this path is, or null for any other file (a copy, a backup, another folder). */
function skillAt(path) {
  const m = SKILL_PATH.exec(path);
  if (!m) return null;
  return SKILL_ROOTS.some((root) => join(homedir(), root, m[1], "SKILL.md") === path) ? m[1] : null;
}

/** Skills a tool call reads: the read tool's path, or a reader command's operands. Writes and listings do not count. */
function skillsRead(call, cwd) {
  const args = call.arguments ?? {};
  if (call.name === "read") {
    const skill = typeof args.path === "string" ? skillAt(normalizePath(args.path, cwd)) : null;
    return skill ? [skill] : [];
  }
  if (typeof args.command !== "string" || !args.command.includes("SKILL.md")) return [];
  const found = [];
  const { cmds, subs } = parse(args.command);
  for (const sub of subs) cmds.push(...parse(sub).cmds);
  for (const { argv } of cmds) {
    const [name, ...rest] = commandArgs(argv);
    if (!READERS.has(name)) continue;
    for (const operand of operands(rest)) {
      const skill = skillAt(normalizePath(operand, cwd));
      if (skill) found.push(skill);
    }
  }
  return found;
}

function skillBlocks(text) {
  const found = [];
  for (const match of text.matchAll(SKILL_BLOCK)) found.push(match[1]);
  return found;
}

/**
 * Tracks which skills were loaded since the last compaction, from session entries (root → leaf).
 * A read counts once its tool result arrives without error. Updates scan only entries added since
 * the previous call; a different branch or rewritten history starts the scan over.
 */
export function createReadTracker(cwd = process.cwd()) {
  let scanned = 0;
  let anchorId = null;
  let read = new Set();
  let pending = new Map();

  const reset = () => {
    scanned = 0;
    anchorId = null;
    read = new Set();
    pending = new Map();
  };

  const apply = (entry) => {
    if (!entry) return;
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      read = new Set();
      pending = new Map();
      return;
    }
    if (entry.type !== "message" || !entry.message) return;
    const { message } = entry;
    if (message.role === "user") {
      for (const skill of skillBlocks(textOf(message.content))) read.add(skill);
      return;
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || part.type !== "toolCall") continue;
        const skills = skillsRead(part, cwd);
        if (skills.length > 0) pending.set(part.id, skills);
      }
      return;
    }
    if (message.role === "toolResult") {
      const skills = pending.get(message.toolCallId);
      if (!skills) return;
      pending.delete(message.toolCallId);
      if (message.isError !== true) for (const skill of skills) read.add(skill);
    }
  };

  return {
    update(entries) {
      const list = Array.isArray(entries) ? entries : [];
      if (scanned > list.length || (scanned > 0 && list[scanned - 1]?.id !== anchorId)) reset();
      for (let i = scanned; i < list.length; i++) apply(list[i]);
      scanned = list.length;
      anchorId = list.length > 0 ? list[list.length - 1]?.id ?? null : null;
      return new Set(read);
    },
  };
}

/**
 * Decides whether a write to `path` may proceed. `installed` maps a skill name to its SKILL.md path or null;
 * a rule whose skills are all uninstalled is skipped, as AGENTS.md says to skip a skill that is not installed.
 */
export function checkWrite({ path, isNew, read, installed = installedSkillPath }) {
  const missing = [];
  for (const rule of rulesFor(path, { isNew })) {
    const available = rule.anyOf.map((skill) => ({ skill, file: installed(skill) })).filter((s) => s.file);
    if (available.length === 0) continue;
    if (available.some(({ skill }) => read.has(skill))) continue;
    const choices = available.map(({ skill, file }) => `\`${skill}\` (${file})`).join(" or ");
    missing.push(`- before ${rule.what}: ${choices}`);
  }
  if (missing.length === 0) return { block: false };
  return {
    block: true,
    reason:
      `~/AGENTS.md requires loading these skills first:\n${missing.join("\n")}\n` +
      `Read each SKILL.md in full, apply it, then retry this write. ` +
      `A skill read before the last compaction no longer counts.`,
  };
}

const DONE_CLAIM = /(?<![\p{L}\d])(?:done|implemented|completed?|finished|fixed|ready for review|listo|lista|terminad[oa]s?|termin[eé]|completad[oa]s?|implementad[oa]s?|arreglad[oa]s?|ya est[aá])(?![\p{L}\d])/giu;
const NEGATED = /(?:\bnot|\bno|n't|a[uú]n no|todav[ií]a no)\s+(?:\S+\s+){0,2}$/i;

function claimsDone(text) {
  for (const match of text.matchAll(DONE_CLAIM)) {
    if (!NEGATED.test(text.slice(Math.max(0, match.index - 40), match.index))) return true;
  }
  return false;
}

const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

const COMMIT_VALUE_SHORT = /[mFCct]$/;
const COMMIT_VALUE_LONG = new Set(["--message", "--file", "--author", "--date", "--template", "--reuse-message", "--reedit-message", "--fixup", "--squash", "--cleanup", "--trailer", "--pathspec-from-file"]);

/** Pathspecs a `git commit` names after its options; `--` ends the options. */
function commitPaths(args) {
  const paths = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--") return [...paths, ...args.slice(k + 1)];
    if (a.startsWith("--")) { if (!a.includes("=") && COMMIT_VALUE_LONG.has(a)) k++; continue; }
    if (a.startsWith("-") && a.length > 1) { if (COMMIT_VALUE_SHORT.test(a)) k++; continue; }
    paths.push(a);
  }
  return paths;
}

/**
 * Each `git commit` a command runs (any global options, also inside sh/bash -c), with what decides its content: the
 * directory (following `cd` and `-C`), `all` for `-a`, the pathspecs it names, and `add` for a `git add` earlier
 * in the same command, which has not run yet when the command is inspected: "all" (-A, ., :/), "tracked" (-u) or its
 * pathspecs. A mention is not a commit.
 */
export function gitCommits(command, cwd) {
  const found = [];
  let add = null;
  const scripts = [{ src: String(command || ""), dir: cwd }];
  for (let s = 0; s < scripts.length && s < 20; s++) {
    let dir = scripts[s].dir;
    const { cmds, subs } = parse(scripts[s].src);
    for (const sub of subs) scripts.push({ src: sub, dir });
    for (const { argv } of cmds) {
      const [name, ...rest] = commandArgs(argv);
      if (name === "cd") {
        dir = normalizePath(operands(rest)[0] ?? "~", dir);
        continue;
      }
      if (SHELLS.has(name)) {
        const c = rest.indexOf("-c");
        if (c >= 0 && rest[c + 1] !== undefined) scripts.push({ src: rest[c + 1], dir });
        continue;
      }
      if (name !== "git") continue;
      let i = 0;
      let where = dir;
      while (i < rest.length && rest[i].startsWith("-")) {
        if (rest[i] === "-C" && rest[i + 1] !== undefined) where = normalizePath(rest[i + 1], where);
        i += GIT_GLOBAL_WITH_VALUE.has(rest[i]) ? 2 : 1;
      }
      const args = rest.slice(i + 1);
      if (rest[i] === "add" || rest[i] === "stage") {
        const specs = args.filter((a) => !a.startsWith("-") || a === "--").filter((a) => a !== "--");
        if (add === "all" || args.some((a) => a === "-A" || a === "--all") || specs.some((p) => p === "." || p === ":/")) add = "all";
        else if (args.some((a) => a === "-u" || a === "--update") && specs.length === 0) add = add ?? "tracked";
        else if (Array.isArray(add)) add.push(...specs);
        else if (add === null) add = specs;
        continue;
      }
      if (rest[i] !== "commit") continue;
      const all = args.some((a) => a === "--all" || (/^-[a-zA-Z]*a[a-zA-Z]*$/.test(a) && !a.startsWith("-u")));
      found.push({ dir: where, all, paths: commitPaths(args), add: Array.isArray(add) ? [...add] : add });
    }
  }
  return found;
}

/** Paths in NUL-separated `git status --porcelain -z` output; a rename or copy lists its new path. */
export function porcelainPaths(output) {
  const parts = String(output || "").split("\0");
  const paths = [];
  for (let k = 0; k < parts.length; k++) {
    const entry = parts[k];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") k++;
  }
  return paths;
}

function runsGitCommit(command) {
  return gitCommits(command, "/").length > 0;
}

/** True when any committed path is code, i.e. not a .md/.mdx/.txt/.rst file. */
export function includesCode(paths) {
  return paths.some((path) => path && !NON_CODE.test(path));
}

const NON_CODE = /\.(?:md|mdx|txt|rst)$/i;

/** The last message the user typed and everything after it: the current run. */
export function sinceLastUser(entries) {
  const list = Array.isArray(entries) ? entries : [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.type === "message" && list[i].message?.role === "user") return list.slice(i);
  }
  return list;
}

/** Successful tool calls in order, each with its name and arguments. */
function succeededCalls(entries) {
  const calls = new Map();
  const done = [];
  for (const entry of entries) {
    const message = entry?.type === "message" ? entry.message : null;
    if (!message) continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) if (part?.type === "toolCall") calls.set(part.id, part);
    } else if (message.role === "toolResult" && message.isError !== true) {
      const call = calls.get(message.toolCallId);
      if (call) done.push(call);
    }
  }
  return done;
}

function finalText(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const message = entries[i]?.type === "message" ? entries[i].message : null;
    if (message?.role === "assistant") return textOf(message.content);
  }
  return "";
}

/** Paths a successful call wrote: the write/edit path, or a shell command's gated targets. */
function writtenBy(call, cwd) {
  const args = call.arguments ?? {};
  if ((call.name === "write" || call.name === "edit") && typeof args.path === "string") return [normalizePath(args.path, cwd)];
  if ((call.name === "bash" || call.name === "bash_background") && typeof args.command === "string") return allShellWriteTargets(args.command, cwd);
  return [];
}

/**
 * slice-plan's show-and-stop reminder for feature documents just created, or null when slice-plan is not installed.
 * Sent at the end of the step that created them, so the model reads it before its next action, not after the run.
 */
export function sliceReminder({ createdDocs, installed = installedSkillPath }) {
  if (createdDocs.length === 0 || !installed("slice-plan")) return null;
  return (
    `Slice guard (~/AGENTS.md): you just created ${createdDocs.map((d) => `\`${d}\``).join(", ")}. ` +
    `Before any implementation, slice-plan requires showing in chat the itemized changed-lines forecast, its total and ` +
    `the verdict. Above 400 lines, show the slice plan and STOP for the user's explicit confirmation of the plan and a ` +
    `\`Stacked\` or \`Chain\` choice; within 400, show the single-unit forecast and continue.`
  );
}

/**
 * The verify-before-pr reminder to append before the run settles, or null: this run changed code, committed it or
 * reported it done, and verify-before-pr was not loaded in it. `runStart` is the branch index where the run's prompt
 * landed; without it the run starts at the last user message, which a mid-run steer message would cut short.
 * `committedCode` is true when a commit in this run included code written earlier ("tested it, ship it").
 */
export function settleReminder({ entries, cwd, runStart, committedCode = false, installed = installedSkillPath }) {
  let start = Number.isInteger(runStart) && runStart >= 0 && runStart <= entries.length ? runStart : -1;
  // Include the prompt itself when it landed just before the recorded index, so a typed /skill: counts.
  if (start > 0 && entries[start - 1]?.type === "message" && entries[start - 1].message?.role === "user") start--;
  const run = start >= 0 ? entries.slice(start) : sinceLastUser(entries);
  const calls = succeededCalls(run);
  const verify = installed("verify-before-pr");
  if (!verify) return null;
  const committed = calls.some((call) => typeof call.arguments?.command === "string" && runsGitCommit(call.arguments.command));
  const codeChanged = committedCode || calls.some((call) => writtenBy(call, cwd).some((path) => !NON_CODE.test(path)));
  if (!codeChanged || createReadTracker(cwd).update(run).has("verify-before-pr")) return null;
  // A commit closes a unit of work even when the final message never says "done".
  if (!committed && !claimsDone(finalText(run))) return null;
  return (
    `Workflow skills (~/AGENTS.md): this run changed code and ${committed ? "committed it" : "your final message reports it as done"}, but ` +
    `\`verify-before-pr\` (${verify}) was not loaded since the user's last message. Load it and follow it before ` +
    `reporting done, or say in one line why nothing runs differently (docs, comments, formatting or tooling config only).`
  );
}
