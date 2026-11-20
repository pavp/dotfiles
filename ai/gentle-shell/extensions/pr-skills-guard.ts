// Blocks `gh pr create`, PR body edits and other ways of opening a PR until the body carries verify-before-pr's
// evidence block, so the PR skills in ~/AGENTS.md run even when gentle's own PR route is taken. User extension:
// lives outside gentle-shell's versioned package, so updates keep it.
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const GATE = pathToFileURL(join(homedir(), ".gentle-shell/agent/extensions/pr-gate-lib/gate.mjs")).href;
const SHELL_TOOLS = new Set(["bash", "bash_background", "monitor"]);
const PR_HINT = /\b(?:pr\s+(?:create|new|edit)|pull-request|api)\b/;

interface ToolCallEvent {
  toolName: string;
  input: { command?: unknown };
}

interface Ctx {
  cwd?: string;
}

interface Pi {
  on(event: "tool_call", handler: (event: ToolCallEvent, ctx: Ctx) => unknown): void;
}

type Check = (command: string, opts: { cwd: string }) => { block: boolean; reason?: string };

export default async function (pi: Pi) {
  if (process.env.GENTLE_PI_AGENTS_CHILD === "1") return;
  let check: Check | null = null;
  pi.on("tool_call", async (event, ctx) => {
    if (!SHELL_TOOLS.has(event.toolName)) return;
    const command = typeof event.input?.command === "string" ? event.input.command : "";
    if (!PR_HINT.test(command.replace(/\\\r?\n/g, " ").replace(/["'\\]/g, ""))) return;
    try {
      check ??= (await import(GATE)).checkCommand as Check;
    } catch (error) {
      return { block: true, reason: `pr-skills-guard could not load ${GATE}: ${String(error)}` };
    }
    try {
      const result = check(command, { cwd: ctx?.cwd ?? process.cwd() });
      return result.block ? { block: true, reason: result.reason } : undefined;
    } catch (error) {
      return { block: true, reason: `pr-skills-guard failed on this command: ${String(error)}` };
    }
  });
}
