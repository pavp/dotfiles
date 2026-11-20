// Blocks a write until the skill ~/AGENTS.md requires for it was read in this session since the last compaction:
// slice-plan before a new odd/tasks/*.md, react-component / react-hooks before .tsx/.jsx/use* files, a ts-* skill
// before .ts/.tsx. Shell writes are seen in their common forms (redirects, tee, sed -i, cp/mv, touch); scripts run by
// other interpreters are not. Also runs in subagents, which write files too.
// In the primary session it also adds reminders: slice-plan's show-and-stop at the end of the step that created a
// feature document, and once per user message before settling, verify-before-pr when changed code is committed or done.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LIB = pathToFileURL(join(homedir(), ".gentle-shell/agent/extensions/skill-gates-lib/gates.mjs")).href;
const WRITE_TOOLS = new Set(["write", "edit"]);
const SHELL_TOOLS = new Set(["bash", "bash_background"]);
const CANDIDATE = /(?:\.md|\.[cm]?[jt]sx?)$/;
const SHELL_CANDIDATE = /\.(?:md|[cm]?[jt]sx?)\b/;
const ODD_DOC = /(?:^|\/)odd\/tasks\/[^/]+\.md$/;
const IS_CHILD = process.env.GENTLE_PI_AGENTS_CHILD === "1";

interface ToolCallEvent {
  toolName: string;
  toolCallId: string;
  input: { path?: unknown; command?: unknown };
}

interface ToolResultEvent {
  toolCallId: string;
  isError: boolean;
}

interface SessionEntry {
  type: string;
  id?: string;
}

interface CustomMessageDraft {
  type: "custom_message";
  customType: string;
  content: string;
  display: boolean;
}

interface InputEvent {
  streamingBehavior?: "steer" | "followUp";
}

interface BoundaryEvent {
  entries: SessionEntry[];
  continue: boolean;
}

interface SettleEvent extends BoundaryEvent {
  outcome: "completed" | "aborted" | "error";
}

interface SettleResult {
  entries: (SessionEntry | CustomMessageDraft)[];
  continue: boolean;
}

interface Ctx {
  cwd?: string;
  sessionManager?: { getBranch(): SessionEntry[] };
}

interface Pi {
  on(event: "tool_call", handler: (event: ToolCallEvent, ctx: Ctx) => unknown): void;
  on(event: "tool_result", handler: (event: ToolResultEvent, ctx: Ctx) => unknown): void;
  on(event: "input", handler: (event: InputEvent, ctx: Ctx) => unknown): void;
  on(event: "turn_end", handler: (event: BoundaryEvent, ctx: Ctx) => unknown): void;
  on(event: "agent_before_settle", handler: (event: SettleEvent, ctx: Ctx) => unknown): void;
}

interface Verdict {
  block: boolean;
  reason?: string;
}

interface CheckInput {
  path: string;
  isNew: boolean;
  read: Set<string>;
}

interface SettleInput {
  entries: SessionEntry[];
  cwd: string;
  runStart?: number;
  committedCode?: boolean;
}

interface CommitPlan {
  dir: string;
  all: boolean;
  paths: string[];
  add: "all" | "tracked" | string[] | null;
}

function git(dir: string, args: string[], signal: AbortSignal): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", dir, ...args], { encoding: "utf8", signal, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout).split("\0").filter(Boolean)));
  });
}

/**
 * Paths a commit will record, read before it runs: what is staged, plus tracked changes for `-a` or `add -u`, the
 * named paths' changes, and what a `git add` earlier in the same command will stage. NUL-separated output keeps names
 * with spaces or accents unquoted. One shared deadline bounds the whole check without blocking Pi's event loop.
 */
async function pathsToCommit(plan: CommitPlan, porcelainPaths: (out: string) => string[], signal: AbortSignal): Promise<string[]> {
  const { dir, all, paths, add } = plan;
  const tracked = (spec: string[]): Promise<string[]> =>
    git(dir, ["diff", "--name-only", "-z", "HEAD", ...(spec.length ? ["--", ...spec] : [])], signal).catch(() =>
      git(dir, ["diff", "--name-only", "-z", ...(spec.length ? ["--", ...spec] : [])], signal));
  const status = async (spec: string[]): Promise<string[]> =>
    porcelainPaths((await git(dir, ["status", "--porcelain", "-z", "--untracked-files=all", ...(spec.length ? ["--", ...spec] : [])], signal)).join("\0"));
  const out = await git(dir, ["diff", "--cached", "--name-only", "-z"], signal);
  if (all || add === "tracked") out.push(...(await tracked([])));
  if (paths.length > 0) out.push(...(await tracked(paths)));
  if (add === "all") out.push(...(await status([])));
  else if (Array.isArray(add) && add.length > 0) out.push(...(await status(add)));
  return out;
}

interface Lib {
  mayBeGated(path: string): boolean;
  normalizePath(raw: string, cwd: string): string;
  shellWriteTargets(command: string, cwd: string): string[];
  checkWrite(input: CheckInput): Verdict;
  createReadTracker(cwd: string): { update(entries: SessionEntry[]): Set<string> };
  settleReminder(input: SettleInput): string | null;
  gitCommits(command: string, cwd: string): CommitPlan[];
  porcelainPaths(output: string): string[];
  includesCode(paths: string[]): boolean;
  sliceReminder(input: { createdDocs: string[] }): string | null;
}

export default async function (pi: Pi): Promise<void> {
  let lib: Lib | null = null;
  let tracker: ReturnType<Lib["createReadTracker"]> | null = null;
  const pendingDocs = new Map<string, string[]>();
  let createdDocs: string[] = [];
  const sliceReminded = new Set<string>();
  let reminded = false;
  let runStart: number | undefined;
  const pendingCommits = new Set<string>();
  let committedCode = false;

  pi.on("input", (event, ctx) => {
    // A message typed while a run is going on steers that run; it does not start a new one.
    if (event?.streamingBehavior) return;
    pendingDocs.clear();
    pendingCommits.clear();
    createdDocs = [];
    committedCode = false;
    reminded = false;
    runStart = ctx?.sessionManager?.getBranch().length;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!IS_CHILD && SHELL_TOOLS.has(event.toolName) && typeof event.input?.command === "string" && event.input.command.includes("commit")) {
      try {
        lib ??= (await import(LIB)) as Lib;
        const cwd = ctx?.cwd ?? process.cwd();
        // Read before the commit runs: afterwards the index is empty and the paths are gone from the diff.
        const signal = AbortSignal.timeout(2000);
        for (const plan of lib.gitCommits(event.input.command, cwd)) {
          if (lib.includesCode(await pathsToCommit(plan, lib.porcelainPaths, signal))) {
            pendingCommits.add(event.toolCallId);
            break;
          }
        }
      } catch {
        // Not a repository, git missing or slow: the reminder then relies on writes made in this run.
      }
    }
    const isWrite = WRITE_TOOLS.has(event.toolName);
    if (!isWrite && !SHELL_TOOLS.has(event.toolName)) return;
    const raw = typeof (isWrite ? event.input?.path : event.input?.command) === "string"
      ? String(isWrite ? event.input.path : event.input.command)
      : "";
    if (!raw || !(isWrite ? CANDIDATE : SHELL_CANDIDATE).test(raw)) return;
    const cwd = ctx?.cwd ?? process.cwd();
    try {
      lib ??= (await import(LIB)) as Lib;
      tracker ??= lib.createReadTracker(cwd);
    } catch (error) {
      // Without the lib a shell command cannot be told from a write, so only the write tools stay gated.
      if (!isWrite) return;
      return { block: true, reason: `skill-gates could not load ${LIB}: ${String(error)}` };
    }
    try {
      const paths = isWrite
        ? lib.mayBeGated(raw.replace(/^@/, "")) ? [lib.normalizePath(raw, cwd)] : []
        : lib.shellWriteTargets(raw, cwd);
      if (paths.length === 0) return;
      const read = tracker.update(ctx?.sessionManager?.getBranch() ?? []);
      const newDocs: string[] = [];
      for (const path of paths) {
        const isNew = !existsSync(path);
        const verdict = lib.checkWrite({ path, isNew, read });
        if (verdict.block) return { block: true, reason: verdict.reason };
        if (isNew && ODD_DOC.test(path)) newDocs.push(path);
      }
      if (newDocs.length > 0) pendingDocs.set(event.toolCallId, newDocs);
      return;
    } catch (error) {
      return { block: true, reason: `skill-gates failed on this ${isWrite ? "write" : "command"}: ${String(error)}` };
    }
  });

  pi.on("tool_result", (event) => {
    if (pendingCommits.delete(event.toolCallId) && !event.isError) committedCode = true;
    const docs = pendingDocs.get(event.toolCallId);
    if (!docs) return;
    pendingDocs.delete(event.toolCallId);
    if (!event.isError) createdDocs.push(...docs.filter((doc) => !createdDocs.includes(doc)));
  });

  pi.on("turn_end", async (event): Promise<SettleResult | undefined> => {
    const fresh = createdDocs.filter((doc) => !sliceReminded.has(doc));
    if (IS_CHILD || fresh.length === 0) return;
    try {
      lib ??= (await import(LIB)) as Lib;
      const content = lib.sliceReminder({ createdDocs: fresh });
      for (const doc of fresh) sliceReminded.add(doc);
      if (!content) return;
      return {
        entries: [...event.entries, { type: "custom_message", customType: "skill-gates.slice-reminder", content, display: true }],
        continue: event.continue,
      };
    } catch {
      return;
    }
  });

  pi.on("agent_before_settle", async (event, ctx): Promise<SettleResult | undefined> => {
    if (IS_CHILD || reminded || event.outcome !== "completed") return;
    try {
      lib ??= (await import(LIB)) as Lib;
      const content = lib.settleReminder({
        entries: ctx?.sessionManager?.getBranch() ?? [],
        cwd: ctx?.cwd ?? process.cwd(),
        runStart,
        committedCode,
      });
      if (!content) return;
      reminded = true;
      return {
        entries: [...event.entries, { type: "custom_message", customType: "skill-gates.settle-reminder", content, display: true }],
        continue: true,
      };
    } catch {
      return;
    }
  });
}
