#!/usr/bin/env node
/* fixit context guard (PreToolUse, every tool) — zero dependencies, Node >= 18.
 *
 * Long sessions are the cost this plugin exists to remove, so past a threshold the model is told to hand over,
 * and a worker under `remedy run` is stopped before compaction loses its detail.
 *
 * It runs on every tool call of every session in every project with the plugin enabled, so:
 *   - No ledger (.remedy/meta.json) in this project: nothing happens, and .fixit/ is not created.
 *   - It only ever denies, or adds context. It never returns an allow decision, which would skip a permission
 *     prompt. mayFinish() below means "do not deny"; those commands still go through normal permissions.
 *   - Any error exits 0 with no output, so a guard bug never blocks a tool. FIXIT_GUARD=off turns it off.
 *
 * Seen on Claude Code 2.1.314: a subagent's hook input has agent_id, and its transcript_path is its parent's, so
 * subagents are skipped (maxTurns and their window bound them). `--agent` on the main thread sets agent_type only.
 * No hook field exposes context use, so it is worked out from the transcript, which lags a turn (see contextOf).
 */
"use strict";
const fs = require("fs");
const path = require("path");

// Where compaction fires, below the window, on a main thread. Lowest pre-compaction figures measured on 2.1.314, Haiku:
// window 150k 114,606 (35.4k below); 120k 85,978 (34.0k); 100k 67,908 (32.1k). Subagents, measured 21-24k, are skipped.
const COMPACT_MARGIN = 35000;
const STOP_BELOW_COMPACT = 15000; // the stop sits this far below compaction, so a report can still be written
const WARN_BELOW_STOP = 15000;    // and the warning this far below the stop, wider than one ordinary file read
const WARN_MAIN = 100000;         // outside a run: never later than this
const RUN_WINDOW = 120000;        // what `remedy run` sets when nothing says otherwise
const WARN_EVERY = 10;            // tool calls between warnings
const TAIL_BYTES = 256 * 1024;
const CHARS_PER_TOKEN = 3;        // for tool output not yet counted by an API call; measured 2.4 on noise, about 3.5 on code

const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };

// The directory holding the ledger, for this cwd: up to the repo root, then a linked worktree's main checkout.
// Plain file reads, because a git process on every tool call would cost more than the rest of this script.
function ledgerRoot(cwd, env = process.env) {
  if (env.REMEDY_DIR) { const d = path.resolve(env.REMEDY_DIR); return exists(path.join(d, "meta.json")) ? path.dirname(d) : null; }
  for (let d = path.resolve(cwd || ".");;) {
    if (exists(path.join(d, ".remedy", "meta.json"))) return d;
    let git = null;
    try { git = fs.readFileSync(path.join(d, ".git"), "utf8"); } catch (e) { if (e.code === "EISDIR") return null; }
    if (git != null) {
      const m = /^gitdir:\s*(.+)$/m.exec(git); // <main>/.git/worktrees/<name>
      if (!m) return null;
      const main = path.dirname(path.resolve(d, m[1].trim(), "..", ".."));
      return exists(path.join(main, ".remedy", "meta.json")) ? main : null;
    }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

// Context now, or null if it cannot be told: the newest usage in the transcript, plus an estimate of the tool output
// written since. The estimate matters: on 2.1.314 the message whose tool call fired this hook is not in the transcript
// yet, so usage alone is one turn old, and at 17k a turn compaction beat the stop while the guard still read 63k.
// Reads only the tail. A compaction newer than any usage means the old figure no longer applies, so that is null too.
function contextOf(transcript) {
  const fd = fs.openSync(transcript, "r");
  let text;
  try {
    const size = fs.fstatSync(fd).size, n = Math.min(size, TAIL_BYTES), buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    text = buf.toString("utf8");
  } finally { fs.closeSync(fd); }
  const lines = text.split("\n");
  let chars = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.includes('"compact_boundary"')) { try { if (JSON.parse(l).subtype === "compact_boundary") return null; } catch { /* a torn line */ } }
    if (l.includes('"tool_result"')) {
      try { // message.content only: the same text appears again in the line's toolUseResult
        const content = JSON.parse(l).message?.content;
        if (Array.isArray(content)) for (const c of content) if (c.type === "tool_result") chars += typeof c.content === "string" ? c.content.length : (c.content || []).reduce((s, x) => s + (x.text?.length || 0), 0);
      } catch { /* a torn line */ }
      continue;
    }
    if (!l.includes('"usage"') || !l.includes('"assistant"')) continue;
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    const u = j.type === "assistant" && !j.isSidechain && j.message?.usage;
    if (!u) continue;
    const c = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (c > 0) return c + Math.round(chars / CHARS_PER_TOKEN); // Claude Code's own placeholder turns have all-zero usage
  }
  return null;
}

// The compaction window this session runs under, if anything we can see sets it. An agent's frontmatter cannot be seen.
function windowOf(root, env = process.env) {
  if (Number(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) > 0) return Number(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  for (const f of [path.join(root, ".claude", "settings.local.json"), path.join(root, ".claude", "settings.json"), path.join(env.HOME || "", ".claude", "settings.json")]) {
    try { const w = JSON.parse(fs.readFileSync(f, "utf8")).autoCompactWindow; if (w > 0) return w; } catch { /* not there, or not ours to judge */ }
  }
  return 0;
}

// Named thresholds. In a run the stop sits below compaction and the warning below the stop, so they fire in order
// at any window. Elsewhere nothing denies; the warning comes at WARN_MAIN, or earlier if compaction would beat it.
function thresholds(env, win) {
  if (env.FIXIT_RUN_ID) {
    const stop = (win || RUN_WINDOW) - COMPACT_MARGIN - STOP_BELOW_COMPACT;
    return { warn: stop - WARN_BELOW_STOP, stop };
  }
  return { warn: win ? Math.min(WARN_MAIN, win - COMPACT_MARGIN - STOP_BELOW_COMPACT) : WARN_MAIN, stop: Infinity };
}

// One plain command as a list of words, or null if the shell would do anything else with it: anything outside
// quotes other than ordinary word characters ends this, including ; & | < > ( ) $ ` \ newlines, globs and comments.
function plainWords(s) {
  const out = [];
  let cur = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") { const e = s.indexOf("'", i + 1); if (e < 0) return null; cur = (cur || "") + s.slice(i + 1, e); i = e; continue; }
    if (c === '"') { const e = s.indexOf('"', i + 1); if (e < 0) return null; const inner = s.slice(i + 1, e); if (/[$`\\!]/.test(inner)) return null; cur = (cur || "") + inner; i = e; continue; }
    if (c === " " || c === "\t") { if (cur !== null) { out.push(cur); cur = null; } continue; }
    if (!/[\w\-.,:=/@+%]/.test(c) && !(cur !== null && /[~^]/.test(c))) return null; // HEAD~1 yes, ~/x no
    cur = (cur || "") + c;
  }
  if (cur !== null) out.push(cur);
  return out;
}
const REMEDY_DO = new Set(["report", "handoff", "done"]);
const GIT_DO = new Set(["status", "diff", "add", "commit"]);
function plainFinish(w) {
  if (!w || w.length < 2) return false;
  if (w[0] === "remedy") return REMEDY_DO.has(w[1]);
  if (w[0] === "git") return GIT_DO.has(w[1]) && !w.some((x) => /^--(output|ext-diff)/.test(x));
  return false;
}
// A command a worker past the stop may still run. Whole-command forms only: a compound never qualifies.
function mayFinish(toolName, command) {
  if (toolName !== "Bash" || typeof command !== "string") return false;
  const s = command.trim();
  if (plainFinish(plainWords(s))) return true;
  // printf '<text>' | remedy report ID
  const p = /^printf(?:[ \t]+(?:'[^']*'|"[^"$`\\!]*"))+[ \t]*\|[ \t]*(remedy[ \t]+report[ \t]+[A-Z][A-Z0-9]*-\d+)$/.exec(s);
  if (p) return true;
  // remedy report ID <<'EOF' ... EOF, with a quoted delimiter (no expansion) and nothing after the terminator
  const h = /^(remedy[ \t]+report[ \t]+[A-Z][A-Z0-9]*-\d+)[ \t]+<<'(\w+)'\n/.exec(s);
  if (h) {
    const body = s.slice(h[0].length).split("\n");
    return body.indexOf(h[2]) === body.length - 1;
  }
  return false;
}

// Warn at most once per WARN_EVERY calls. State lives in the main checkout's self-ignoring .fixit/.
function shouldWarn(root, session) {
  const dir = path.join(root, ".fixit", "guard");
  fs.mkdirSync(dir, { recursive: true });
  const ig = path.join(root, ".fixit", ".gitignore");
  if (!exists(ig)) { try { fs.writeFileSync(ig, "*\n", { flag: "wx" }); } catch { /* another process won */ } }
  const f = path.join(dir, String(session).replace(/[^\w-]/g, "_") + ".json");
  let st = { calls: 0, warned: null };
  try { st = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* first time */ }
  st.calls++;
  const warn = st.warned === null || st.calls - st.warned >= WARN_EVERY;
  if (warn) st.warned = st.calls;
  fs.writeFileSync(f, JSON.stringify(st));
  return warn;
}

function guard(input, env = process.env) {
  if (input.agent_id) return null; // a subagent; transcript_path here is its parent's
  const root = ledgerRoot(input.cwd, env);
  if (!root || !input.transcript_path) return null;
  const ctx = contextOf(input.transcript_path);
  if (ctx == null) return null;
  const { warn, stop } = thresholds(env, windowOf(root, env));
  const k = Math.round(ctx / 1000), item = (env.REMEDY_RUN_ITEM || "<ID>").split(",")[0];
  if (ctx >= stop) {
    if (mayFinish(input.tool_name, input.tool_input?.command)) return null;
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
      permissionDecisionReason: `Context ${k}k. Write a handoff: remedy report ${item}, then stop. Use one plain call: printf 'status: handoff\\n...' | remedy report ${item}` } };
  }
  if (ctx >= warn && shouldWarn(root, input.session_id || "session")) {
    const text = env.FIXIT_RUN_ID ? `[fixit] context ${k}k of a ${Math.round(stop / 1000)}k limit. Carry on in small steps and keep remedy report ${item} current; the guard says when to stop.` : `[fixit] context ${k}k. Finish this step, then run remedy handoff.`;
    return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } };
  }
  return null;
}

if (require.main === module) {
  try {
    if (process.env.FIXIT_GUARD !== "off") {
      const out = guard(JSON.parse(fs.readFileSync(0, "utf8")));
      if (out) process.stdout.write(JSON.stringify(out));
    }
  } catch { /* see header: never block a tool call */ }
}
module.exports = { guard, thresholds, mayFinish, plainWords, ledgerRoot, contextOf, windowOf, COMPACT_MARGIN, STOP_BELOW_COMPACT, WARN_BELOW_STOP, WARN_MAIN, RUN_WINDOW, WARN_EVERY };
