// node --test hooks/context-guard.test.cjs
// Fixture hook input and fixture transcripts. Whether Claude Code acts on the output is a live question, not tested here.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const G = require("./context-guard.cjs");

const HOOK = path.join(__dirname, "context-guard.cjs"), START = path.join(__dirname, "session-start.cjs");
const cleanEnv = (extra = {}) => {
  const env = { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), "guard-home-")), ...extra };
  for (const k of ["FIXIT_RUN_ID", "REMEDY_RUN_ITEM", "REMEDY_DIR", "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "FIXIT_GUARD"]) if (!(k in extra)) delete env[k];
  return env;
};
function run(hook, input, env) {
  const r = cp.spawnSync(process.execPath, [hook], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", env: cleanEnv(env) });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function project({ ledger = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-")));
  cp.execFileSync("git", ["init", "-q", root]);
  if (ledger) { fs.mkdirSync(path.join(root, ".remedy")); fs.writeFileSync(path.join(root, ".remedy", "meta.json"), "{}"); }
  return root;
}
const assistant = (ctx, extra = {}) => JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 10, cache_read_input_tokens: ctx - 10, cache_creation_input_tokens: 0, output_tokens: 5 } }, ...extra });
function transcript(root, lines) {
  const f = path.join(root, "t-" + Math.random().toString(36).slice(2) + ".jsonl");
  fs.writeFileSync(f, lines.join("\n") + "\n");
  return f;
}
const input = (root, t, extra = {}) => ({ hook_event_name: "PreToolUse", session_id: "s-1", cwd: root, transcript_path: t, tool_name: "Bash", tool_input: { command: "ls" }, ...extra });
const decision = (r) => (r.out ? JSON.parse(r.out).hookSpecificOutput : null);
const RUN = { FIXIT_RUN_ID: "X-01-1", REMEDY_RUN_ITEM: "X-01" };

test("no ledger: nothing at all, at any context, and no .fixit/ is created", () => {
  const root = project({ ledger: false });
  for (const env of [{}, RUN]) {
    const r = run(HOOK, input(root, transcript(root, [assistant(900000)])), env);
    assert.deepEqual([r.code, r.out, r.err], [0, "", ""]);
  }
  assert.equal(fs.existsSync(path.join(root, ".fixit")), false);
});

test("a ledger in a parent repository does not count; a linked worktree finds its main checkout's without git", () => {
  const outer = project();
  const inner = path.join(outer, "vendor", "inner");
  fs.mkdirSync(inner, { recursive: true });
  cp.execFileSync("git", ["init", "-q", inner]);
  assert.equal(G.ledgerRoot(inner, {}), null);
  fs.mkdirSync(path.join(outer, "src", "deep"), { recursive: true });
  assert.equal(G.ledgerRoot(path.join(outer, "src", "deep"), {}), outer, "a subdirectory of the repo");
  const wt = path.join(outer, ".fixit", "worktrees", "A");
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(outer, ".git", "worktrees", "A")}\n`);
  assert.equal(G.ledgerRoot(wt, {}), outer);
  assert.equal(G.ledgerRoot(wt, { REMEDY_DIR: path.join(outer, ".remedy") }), outer);
  assert.equal(G.ledgerRoot(wt, { REMEDY_DIR: "/nonexistent/.remedy" }), null);
});

test("FIXIT_GUARD=off exits at once; unparseable input of every kind exits 0 with no output", () => {
  const root = project();
  const t = transcript(root, [assistant(900000)]);
  assert.deepEqual(run(HOOK, input(root, t), { ...RUN, FIXIT_GUARD: "off" }).out, "");
  for (const bad of ["", "not json", "[]", "null", "{}"]) { const r = run(HOOK, bad, RUN); assert.deepEqual([r.code, r.out, r.err], [0, "", ""], `stdin ${bad}`); }
  const cases = {
    "missing file": path.join(root, "nope.jsonl"),
    "a directory": root,
    "not JSON lines": transcript(root, ["garbage", "{torn", "]["]),
    "no assistant line": transcript(root, [JSON.stringify({ type: "user", message: {} })]),
    "assistant with no usage": transcript(root, [JSON.stringify({ type: "assistant", message: {} })]),
    "usage of the wrong shape": transcript(root, ['{"type":"assistant","message":{"usage":"lots"}}']),
    "empty": transcript(root, [""]),
  };
  for (const [name, f] of Object.entries(cases)) { const r = run(HOOK, input(root, f), RUN); assert.deepEqual([r.code, r.out, r.err], [0, "", ""], name); }
  assert.equal(run(HOOK, input(root, undefined), RUN).out, "", "no transcript_path");
});

test("a subagent is skipped, by agent_id; --agent on the main thread sets agent_type only and is not skipped", () => {
  const root = project();
  const t = transcript(root, [assistant(900000)]);
  assert.equal(run(HOOK, input(root, t, { agent_id: "a1", agent_type: "x:y" }), RUN).out, "");
  assert.equal(decision(run(HOOK, input(root, t, { agent_type: "x:y" }), RUN)).permissionDecision, "deny");
});

test("thresholds are named values and fire in order: warn, then stop, then where compaction was measured", () => {
  const measuredCompaction = { 120000: 85978, 100000: 67908 }; // lowest pre-compaction figures on a print-mode main thread
  for (const win of [120000, 100000]) {
    const t = G.thresholds({ FIXIT_RUN_ID: "x" }, win);
    assert.ok(t.warn < t.stop, `warn before stop at ${win}`);
    const below = measuredCompaction[win] - t.stop;
    assert.ok(below >= 10000 && below <= 20000, `stop is ${below} below compaction at ${win}`);
  }
  assert.equal(G.thresholds({ FIXIT_RUN_ID: "x" }, 0).stop, G.RUN_WINDOW - G.COMPACT_MARGIN - G.STOP_BELOW_COMPACT, "no window seen: remedy run's");
  // Outside a run nothing denies, and the warning beats compaction at any window.
  assert.deepEqual(G.thresholds({}, 0), { warn: G.WARN_MAIN, stop: Infinity });
  assert.equal(G.thresholds({}, 150000).warn, 100000, "the project window init --settings proposes; compaction measured at 114,606");
  assert.equal(G.thresholds({}, 500000).warn, G.WARN_MAIN);
  assert.ok(G.thresholds({}, 120000).warn < 85978 - 10000, "a lower window pulls the warning down");
  assert.ok(G.thresholds({}, 100000).warn < 67908 - 10000);
});

test("outside a run: warns at 100k, at most once per 10 calls, never denies; state is under a self-ignoring .fixit/", () => {
  const root = project();
  const t = transcript(root, [assistant(99999)]);
  assert.equal(run(HOOK, input(root, t)).out, "", "under the threshold");
  assert.equal(fs.existsSync(path.join(root, ".fixit")), false, "under the threshold nothing is written");
  const t2 = transcript(root, [assistant(123456)]);
  const seen = [];
  for (let i = 0; i < 21; i++) seen.push(decision(run(HOOK, input(root, t2))));
  const warned = seen.map((d, i) => (d ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(warned, [0, 10, 20]);
  assert.equal(seen[0].hookEventName, "PreToolUse");
  assert.equal(seen[0].additionalContext, "[fixit] context 123k. Finish this step, then run remedy handoff.");
  assert.equal(seen[0].permissionDecision, undefined);
  assert.equal(fs.readFileSync(path.join(root, ".fixit", ".gitignore"), "utf8"), "*\n");
  assert.ok(fs.existsSync(path.join(root, ".fixit", "guard", "s-1.json")));
  const huge = transcript(root, [assistant(900000)]);
  for (let i = 0; i < 3; i++) { const d = decision(run(HOOK, input(root, huge, { session_id: "s-2" }))); assert.notEqual(d?.permissionDecision, "deny"); }
});

test("a project window lower than the default pulls the warning down outside a run", () => {
  const root = project();
  fs.mkdirSync(path.join(root, ".claude"));
  fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({ autoCompactWindow: 120000 }));
  const t = transcript(root, [assistant(75000)]);
  assert.match(decision(run(HOOK, input(root, t))).additionalContext, /context 75k/);
});

test("in a run: warns first, then denies at the stop, with the item in the reason", () => {
  const root = project();
  const env = { ...RUN, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "120000" };
  const { warn, stop } = G.thresholds({ FIXIT_RUN_ID: "x" }, 120000);
  assert.equal(run(HOOK, input(root, transcript(root, [assistant(warn - 1)])), env).out, "");
  const w = decision(run(HOOK, input(root, transcript(root, [assistant(warn)])), env));
  assert.equal(w.permissionDecision, undefined);
  assert.match(w.additionalContext, /context 55k of a 70k limit\. Carry on in small steps and keep remedy report X-01 current/);
  const d = decision(run(HOOK, input(root, transcript(root, [assistant(stop)])), env));
  assert.equal(d.permissionDecision, "deny");
  assert.match(d.permissionDecisionReason, /^Context 70k\. Write a handoff: remedy report X-01, then stop\./);
});

test("past the stop every tool but the finishing commands is denied; those produce no output, so normal permissions apply", () => {
  const root = project();
  const t = transcript(root, [assistant(200000)]);
  for (const tool of ["Read", "Edit", "Write", "Glob", "Agent"]) assert.equal(decision(run(HOOK, input(root, t, { tool_name: tool, tool_input: { file_path: "x" } }), RUN)).permissionDecision, "deny", tool);
  const r = run(HOOK, input(root, t, { tool_input: { command: "remedy report X-01 --show" } }), RUN);
  assert.deepEqual([r.code, r.out], [0, ""]);
});

test("the finishing list takes whole commands only; a compound is never on it", () => {
  const yes = [
    "remedy report X-01", "remedy report X-01 --show", "remedy handoff --next 'do this'", "remedy handoff", "remedy done X-01 --commit abc1234",
    "git status", "git status --short", "git diff", "git diff --stat HEAD~1", "git add -A", "git add price/price.go", "git commit -m 'fix the total'", 'git commit -m "fix the total"',
    "git commit -m 'line one\nline two'",
    "printf 'status: handoff\\nnext: x\\n' | remedy report X-01", "printf 'a; rm -rf y && b $(c)' | remedy report X-01", "printf '%s\\n' 'status: stuck' | remedy report X-01",
    "remedy report X-01 <<'EOF'\nstatus: handoff\n$(not run) ; rm -rf y\nEOF", "  git status  ",
  ];
  const no = [
    "remedy report X; rm -rf y", "remedy report X-01; rm -rf y", "remedy report X-01 && rm -rf y", "remedy report X-01 || rm -rf y", "remedy report X-01 | sh", "remedy report X-01 & rm -rf y", "remedy report X-01 &",
    "remedy report X-01\nrm -rf y", "remedy report X-01 > /etc/passwd", "remedy report X-01 < /etc/passwd", "remedy report $(rm -rf y)", "remedy report `rm -rf y`", 'remedy report "$(rm -rf y)"', 'remedy report "`id`"', "remedy report \\; rm", "remedy report (x)",
    "git status; rm -rf y", "git status && rm -rf y", "git diff | sh", "git add . ; git push", "git add -A && git commit -m x", "git commit -m \"$(rm -rf y)\"", "git diff --output=/etc/passwd", "git diff --ext-diff", "git -c core.sshCommand=x status", "git -C /other status", "git push", "git log", "git checkout .",
    "FOO=1 git status", "cd x && git status", "env git status", "sudo git status", "bash -c 'git status'", "sh -c 'remedy report X-01'",
    "remedy approve X-01 --by me", "remedy stage X-01 approved", "remedy run X-01", "remedy brief X-01", "/tmp/evil/remedy report X-01", "./remedy report X-01",
    "printf 'x' | remedy report X-01; rm -rf y", "printf 'x' | remedy report X-01 && rm -rf y", "printf 'x' | remedy approve X-01", "printf 'x' | sh", "printf 'x'; rm -rf y | remedy report X-01", "printf \"$(id)\" | remedy report X-01", "printf `id` | remedy report X-01", "printf x | remedy report X-01",
    "cat /etc/passwd | remedy report X-01", "rm -rf y | remedy report X-01", "printf 'x' | tee y | remedy report X-01", "printf 'x' > y | remedy report X-01",
    "remedy report X-01 <<EOF\n$(rm -rf y)\nEOF", "remedy report X-01 <<'EOF'\nbody\nEOF\nrm -rf y", "remedy report X-01 <<'EOF'\nbody\nEOF\nrm -rf y\nEOF", "remedy report X-01 <<'EOF'\nnever closed", "remedy report X-01 <<'EOF'; rm -rf y\nbody\nEOF",
    "", "   ", "remedy", "git",
  ];
  for (const c of yes) assert.equal(G.mayFinish("Bash", c), true, JSON.stringify(c));
  for (const c of no) assert.equal(G.mayFinish("Bash", c), false, JSON.stringify(c));
  assert.equal(G.mayFinish("Read", "git status"), false);
  assert.equal(G.mayFinish("Bash", undefined), false);
});

test("the guard's code can never return an allow decision", () => {
  const src = fs.readFileSync(HOOK, "utf8");
  const decisions = [...src.matchAll(/permissionDecision:\s*"(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(decisions, ["deny"]);
  assert.doesNotMatch(src, /"allow"|"ask"|updatedInput|continue:/);
  for (const ctx of [50000, 150000, 900000]) {
    const root = project(), t = transcript(root, [assistant(ctx)]);
    const r = run(HOOK, input(root, t, { tool_input: { command: "git status" } }), RUN);
    assert.notEqual(decision(r)?.permissionDecision, "allow");
  }
});

test("usage: newest real figure from the tail; placeholder turns are skipped; a newer compaction means unknown", () => {
  const root = project();
  assert.equal(G.contextOf(transcript(root, [assistant(50000), assistant(60000)])), 60000);
  assert.equal(G.contextOf(transcript(root, [assistant(60000), assistant(0), "{torn"])), 60000);
  assert.equal(G.contextOf(transcript(root, [assistant(60000), assistant(70000, { isSidechain: true })])), 60000);
  const boundary = JSON.stringify({ type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 90000 } });
  assert.equal(G.contextOf(transcript(root, [assistant(90000), boundary])), null);
  assert.equal(G.contextOf(transcript(root, [assistant(90000), boundary, assistant(20000)])), 20000);
  // Tool output since the newest usage is estimated, since that usage is a turn old when the hook fires. Once only.
  const result = (text, dup = "") => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: text }] }, toolUseResult: { stdout: dup } });
  assert.equal(G.contextOf(transcript(root, [assistant(60000), result("x".repeat(30000), "x".repeat(30000))])), 70000);
  assert.equal(G.contextOf(transcript(root, [assistant(60000), result([{ type: "text", text: "y".repeat(3000) }])])), 61000, "the array form");
  assert.equal(G.contextOf(transcript(root, [result("x".repeat(30000)), assistant(60000)])), 60000, "output before the usage is already in it");
  assert.equal(G.contextOf(transcript(root, [assistant(90000), boundary, result("x".repeat(3000))])), null);
  // Only the last 256 KB is read: a line further back does not count, and a cut first line does not throw.
  const pad = JSON.stringify({ type: "user", message: { content: "x".repeat(300 * 1024) } });
  assert.equal(G.contextOf(transcript(root, [assistant(90000), pad])), null);
});

test("session-start: past 100k on resume, one line; otherwise nothing", () => {
  const root = project(), noLedger = project({ ledger: false });
  const t = transcript(root, [assistant(150000)]);
  const base = { hook_event_name: "SessionStart", source: "resume", cwd: root, transcript_path: t };
  const line = run(START, { ...base, context_tokens: 123456 }).out;
  assert.equal(line, "[fixit] Resumed at 123k of context. A fresh session is cheaper: remedy handoff, then claude, then remedy handoff --latest.\n");
  assert.match(run(START, base).out, /Resumed at 150k/, "falls back to the transcript");
  assert.equal(run(START, { ...base, context_tokens: 100000 }).out, "");
  assert.equal(run(START, { ...base, source: "startup", context_tokens: 500000 }).out, "");
  assert.equal(run(START, { ...base, cwd: noLedger, context_tokens: 500000 }).out, "");
  assert.equal(run(START, { ...base, context_tokens: 500000 }, { FIXIT_GUARD: "off" }).out, "");
  for (const bad of ["", "nope", "{}"]) assert.deepEqual([run(START, bad).code, run(START, bad).out], [0, ""]);
  assert.equal(fs.existsSync(path.join(noLedger, ".fixit")), false);
});

test("hooks.json registers the guard on every tool and session-start on resume, and names no removed hook", () => {
  const raw = fs.readFileSync(path.join(__dirname, "hooks.json"), "utf8"), { hooks } = JSON.parse(raw);
  const script = (e) => e.hooks[0].command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/(hooks\/[\w.-]+)/)[1];
  assert.deepEqual(hooks.PreToolUse.map((e) => [e.matcher, script(e)]), [["*", "hooks/context-guard.cjs"]]);
  assert.deepEqual(hooks.SessionStart.map((e) => [e.matcher, script(e)]), [["resume", "hooks/session-start.cjs"]]);
  for (const e of [...hooks.PreToolUse, ...hooks.SessionStart]) { assert.ok(fs.existsSync(path.join(__dirname, "..", script(e)))); assert.equal(e.hooks[0].timeout, 5); }
  assert.doesNotMatch(raw, /pre-bash/);
});
