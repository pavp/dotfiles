// Blocks opening or rewriting a PR description whose body lacks verify-before-pr's evidence markers.
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

const EVIDENCE = /<!--\s*evidence:start\s*-->[\s\S]*<!--\s*evidence:end\s*-->/;
const SKIP = /<!--\s*evidence:skip:\s*[^\s>-][^>]*-->/;

export const REASON =
  "PR blocked: its body has no evidence block. Load the verify-before-pr skill (read ~/.agents/skills/verify-before-pr/SKILL.md) and run it, " +
  "then load pr-description (~/.agents/skills/pr-description/SKILL.md) and put its pr-block.md between <!-- evidence:start --> and <!-- evidence:end -->. " +
  "When nothing runs differently (docs, comments, formatting), add <!-- evidence:skip: <reason> --> instead.";

const hasEvidence = (text) => EVIDENCE.test(text) || SKIP.test(text);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "time", "nohup", "exec", "command", "builtin"]);

/** Reads a balanced `$(…)` starting after its `(`, skipping heredoc bodies; returns [content, index after the closing paren]. */
function balanced(src, i) {
  let depth = 1, quote = null, out = "", pending = [];
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"') { out += c + src[++i]; continue; }
    } else if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
      const m = /^<<-?[ \t]*(['"]?)([^\s'";&|<>()]+)\1/.exec(src.slice(i));
      if (m) { pending.push(m[2]); out += m[0]; i += m[0].length - 1; continue; }
    } else if (c === "\n" && pending.length) {
      out += c;
      for (const delim of pending) {
        while (i + 1 < src.length) {
          const end = src.indexOf("\n", i + 1);
          const line = src.slice(i + 1, end < 0 ? src.length : end);
          out += line + "\n";
          i = end < 0 ? src.length : end;
          if (line.trim() === delim) break;
        }
      }
      pending = [];
      continue;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return [out, i + 1];
    out += c;
  }
  return [out, i];
}

/**
 * Splits a shell command into simple commands: `{ argv, heredoc }`, plus the scripts nested in `$(…)` and backticks.
 * A small lexer, not a shell: enough to tell a PR command from a search for one.
 */
export function parse(command) {
  const src = String(command || "").replace(/\\\r?\n/g, " ");
  const cmds = [], subs = [];
  let argv = [], word = null, quote = null, heredocs = [], pending = [], arith = false;
  const endWord = () => { if (word !== null) argv.push(word); word = null; };
  const endCmd = () => { endWord(); if (argv.length) cmds.push({ argv, heredoc: heredocs.join("\n") }); argv = []; heredocs = []; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote === "'") { if (c === "'") quote = null; else word += c; continue; }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < src.length) word += src[++i];
      else if (c === "$" && src[i + 1] === "(") { const [s, j] = balanced(src, i + 2); subs.push(s); word += "$(" + s + ")"; i = j - 1; }
      else if (c === "`") { const j = src.indexOf("`", i + 1); subs.push(src.slice(i + 1, j < 0 ? undefined : j)); word += src.slice(i, j < 0 ? undefined : j + 1); i = j < 0 ? src.length : j; }
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { word ??= ""; quote = c; continue; }
    if (c === "\\" && i + 1 < src.length) { word = (word ?? "") + src[++i]; continue; }
    if (c === "$" && src[i + 1] === "(") { const [s, j] = balanced(src, i + 2); subs.push(s); word = (word ?? "") + "$(" + s + ")"; i = j - 1; continue; }
    if (c === "`") { const j = src.indexOf("`", i + 1); subs.push(src.slice(i + 1, j < 0 ? undefined : j)); word = (word ?? "") + src.slice(i, j < 0 ? undefined : j + 1); i = j < 0 ? src.length : j; continue; }
    if (c === "#" && word === null) { while (i + 1 < src.length && src[i + 1] !== "\n") i++; continue; }
    if (c === "(" && src[i + 1] === "(") arith = true;
    if (c === ")" && src[i + 1] === ")") arith = false;
    if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<" && !arith) {
      endWord();
      let j = i + 2;
      if (src[j] === "-") j++;
      while (src[j] === " " || src[j] === "\t") j++;
      const m = /^(['"]?)([^\s'";&|<>]+)\1/.exec(src.slice(j));
      if (m) { pending.push(m[2]); i = j + m[0].length - 1; argv.push("<<" + m[2]); continue; }
    }
    if (c === "&" && (src[i - 1] === ">" || src[i - 1] === "<" || src[i + 1] === ">")) { word = (word ?? "") + c; continue; }
    if (c === "\n") {
      endCmd();
      for (const delim of pending) {
        const body = [];
        while (i + 1 < src.length) {
          const end = src.indexOf("\n", i + 1);
          const line = src.slice(i + 1, end < 0 ? src.length : end);
          i = end < 0 ? src.length : end;
          if (line.trim() === delim) break;
          body.push(line);
        }
        const last = cmds[cmds.length - 1];
        if (last) last.heredoc += (last.heredoc ? "\n" : "") + body.join("\n");
      }
      pending = [];
      arith = false;
      continue;
    }
    if (";&|()".includes(c)) { endCmd(); continue; }
    if (c === " " || c === "\t") { endWord(); continue; }
    word = (word ?? "") + c;
  }
  endCmd();
  return { cmds, subs };
}

/** The command's own argv: leading assignments, wrappers and shell keywords removed. */
function strip(argv) {
  let i = 0;
  for (;;) {
    const a = argv[i];
    if (a === undefined) return [];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a) || KEYWORDS.has(a)) i++;
    else if (a === "env") { i++; while (argv[i] && (/^-/.test(argv[i]) || /=/.test(argv[i]))) i++; }
    else if (a === "sudo") { i++; while (argv[i] && /^-/.test(argv[i])) i += /^-[ugCDhpRrTt]$/.test(argv[i]) ? 2 : 1; }
    else if (a === "timeout") { i++; while (argv[i] && /^-/.test(argv[i])) i++; i++; }
    else if (a === "xargs") { i++; while (argv[i] && /^-/.test(argv[i])) i++; }
    else return argv.slice(i);
  }
}

/** Value of a flag given as `--name v`, `--name=v`, or `-x v` / `-xv` for one-letter short forms. */
function flagValues(args, long, short) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    for (const l of long) {
      if (a === l) out.push(args[i + 1] ?? "");
      else if (a.startsWith(l + "=")) out.push(a.slice(l.length + 1));
    }
    for (const s of short) {
      if (a === s) out.push(args[i + 1] ?? "");
      else if (a.startsWith(s) && a.length > s.length && !a.startsWith("--")) out.push(a.slice(s.length));
    }
  }
  return out;
}

function readBody(name, ctx, heredoc) {
  if (name === "-") return { text: heredoc };
  const path = isAbsolute(name) ? name : ctx.bases.map((d) => resolve(d, name)).find(existsSync);
  if (!path || !existsSync(path)) return { missing: name };
  return { text: readFileSync(path, "utf8") };
}

/** A blocking reason when the given body sources carry no evidence, else null. */
function judge(inline, files, ctx, heredoc) {
  if (inline.some(hasEvidence)) return null;
  for (const f of files) {
    const r = readBody(f, ctx, heredoc);
    if (r.missing) return `${REASON} (Could not read the body file ${r.missing}.)`;
    if (hasEvidence(r.text)) return null;
  }
  return REASON;
}

function checkGh(args, ctx, heredoc) {
  let i = 0;
  while (args[i] && args[i].startsWith("-")) i += /^(-R|--repo|--hostname)$/.test(args[i]) ? 2 : 1;
  const [group, verb] = [args[i], args[i + 1]];
  const rest = args.slice(i + 2);
  if (group === "pr" && (verb === "create" || verb === "new")) {
    if (rest.includes("--web") || rest.includes("-w")) return null;
    return judge(flagValues(rest, ["--body"], ["-b"]), flagValues(rest, ["--body-file"], ["-F"]), ctx, heredoc);
  }
  if (group === "pr" && verb === "edit") {
    const inline = flagValues(rest, ["--body"], ["-b"]), files = flagValues(rest, ["--body-file"], ["-F"]);
    return inline.length || files.length ? judge(inline, files, ctx, heredoc) : null;
  }
  if (group === "api") {
    const tail = args.slice(i + 1);
    const method = (flagValues(tail, ["--method"], ["-X"])[0] || "").toUpperCase();
    const fields = [...flagValues(tail, ["--field", "--raw-field"], ["-f", "-F"])];
    const input = flagValues(tail, ["--input"], []);
    const endpoint = tail.find((a, k) => !a.startsWith("-") && !/^(-X|--method|-f|-F|--field|--raw-field|--input|-H|--header|-q|--jq|-t|--template)$/.test(tail[k - 1] ?? "")) || "";
    const writes = method ? method !== "GET" : fields.length > 0 || input.length > 0;
    if (!writes) return null;
    const bodyOf = (v) => v.replace(/^body=/, "");
    if (/(^|\/)pulls\/?$/.test(endpoint) || (/(^|\/)pulls\/\d+\/?$/.test(endpoint) && fields.some((f) => f.startsWith("body=")))) {
      return judge(fields.filter((f) => f.startsWith("body=")).map(bodyOf), input, ctx, heredoc);
    }
    if (endpoint === "graphql") {
      const queries = fields.filter((f) => f.startsWith("query=")).map((f) => f.slice(6));
      const texts = queries.map((q) => (q.startsWith("@") ? readBody(q.slice(1), ctx, heredoc).text ?? "createPullRequest" : q));
      if (texts.some((q) => /createPullRequest|updatePullRequest/.test(q)) && !texts.some(hasEvidence)) return REASON;
    }
  }
  return null;
}

function checkHub(args, ctx) {
  let i = 0;
  while (args[i] && args[i].startsWith("-")) i += /^(-C|-c)$/.test(args[i]) ? 2 : 1;
  if (args[i] !== "pull-request") return null;
  const rest = args.slice(i + 1);
  return judge(flagValues(rest, ["--message"], ["-m"]), flagValues(rest, ["--file"], ["-F"]), ctx, "");
}

function scan(command, ctx, depth) {
  if (depth > 4) return null;
  const { cmds, subs } = parse(command);
  for (const { argv, heredoc } of cmds) {
    const words = strip(argv);
    if (!words.length) continue;
    const name = basename(words[0]);
    if (name === "cd" && words[1]) ctx.bases.push(resolve(ctx.bases[ctx.bases.length - 1], words[1]));
    let reason = null;
    if (name === "gh") reason = checkGh(words.slice(1), ctx, heredoc);
    else if (name === "hub") reason = checkHub(words.slice(1), ctx);
    else if (SHELLS.has(name)) {
      const k = words.findIndex((w, n) => n > 0 && /^-[a-z]*c[a-z]*$/.test(w));
      if (k > 0 && words[k + 1] !== undefined) reason = scan(words[k + 1], ctx, depth + 1);
    } else if (name === "eval") reason = scan(words.slice(1).join(" "), ctx, depth + 1);
    if (reason) return reason;
  }
  for (const s of subs) {
    const reason = scan(s, ctx, depth + 1);
    if (reason) return reason;
  }
  return null;
}

/**
 * Whether a shell command opens a PR or replaces its description without the evidence markers in that body.
 * @returns {{ block: boolean, reason?: string }}
 */
export function checkCommand(command, { cwd = process.cwd() } = {}) {
  const reason = scan(command, { bases: [cwd] }, 0);
  return reason ? { block: true, reason } : { block: false };
}
