// node --test skills/remedy/scripts/usage.test.cjs
// Uses a small synthetic transcript tree built here. No real transcript data.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const CLI = path.join(__dirname, "remedy.cjs");
const U = (i, cr, cc, out) => ({ input_tokens: i, cache_read_input_tokens: cr, cache_creation_input_tokens: cc, output_tokens: out });
const line = (o) => JSON.stringify(o) + "\n";
const asst = (id, ts, usage, content, model = "claude-opus-5-5") => line({ type: "assistant", timestamp: ts, message: { id, model, usage, content } });
const bash = (id, command) => ({ type: "tool_use", id, name: "Bash", input: { command } });
const result = (id, content, extra = {}) => line({ type: "user", timestamp: "2026-11-01T10:00:09Z", message: { content: [{ type: "tool_result", tool_use_id: id, content }] }, ...extra });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-"));
  const proj = path.join(root, "projects");
  const a = path.join(proj, "-work-alpha"), b = path.join(proj, "-work-beta"), x = path.join(proj, "-tmp-alpha-extra");
  fs.mkdirSync(path.join(a, "s1", "subagents"), { recursive: true }); fs.mkdirSync(b, { recursive: true }); fs.mkdirSync(x, { recursive: true });
  // main session: message m1 is written twice (usage grows), a synthetic turn, a compaction, item attribution.
  fs.writeFileSync(path.join(a, "s1.jsonl"),
    asst("m1", "2026-11-01T10:00:00Z", U(10, 0, 30000, 5), [{ type: "text", text: "x" }]) +
    asst("m1", "2026-11-01T10:00:01Z", U(10, 0, 30000, 50), [bash("t1", "node remedy.cjs brief SEC-01,WF-01")]) +
    result("t1", "a".repeat(20)) +
    asst("syn", "2026-11-01T10:00:02Z", U(0, 0, 0, 0), [{ type: "text", text: "n" }], "<synthetic>") +
    asst("m2", "2026-11-01T10:00:10Z", U(10, 30000, 100, 20), [bash("t2", "fixit test x"), bash("t3", "git status")]) +
    result("t2", "b".repeat(20000)) + result("t3", "ok") +
    line({ type: "system", subtype: "compact_boundary", timestamp: "2026-11-01T10:01:00Z", compactMetadata: { preTokens: 120000 } }) +
    asst("m3", "2026-11-02T12:00:00Z", U(5, 30100, 200, 10), [{ type: "tool_use", id: "ag1", name: "Agent", input: { subagent_type: "builder", model: "haiku", prompt: "p" } }]) +
    line({ type: "user", timestamp: "2026-11-02T12:00:05Z", toolUseResult: { agentId: "aaa", resolvedModel: "claude-sonnet-5-5" }, message: { content: [{ type: "tool_result", tool_use_id: "ag1", content: "done" }] } }));
  fs.writeFileSync(path.join(a, "s1", "subagents", "agent-aaa.jsonl"),
    asst("s1", "2026-11-02T12:00:06Z", U(1, 0, 25000, 10), [{ type: "text", text: "w" }], "claude-sonnet-5-5") +
    asst("s2", "2026-11-02T12:00:20Z", U(1, 25000, 10, 10), [{ type: "text", text: "w" }], "claude-sonnet-5-5"));
  fs.writeFileSync(path.join(a, "s1", "subagents", "agent-aaa.meta.json"), JSON.stringify({ agentType: "builder", toolUseId: "ag1" }));
  fs.writeFileSync(path.join(b, "s2.jsonl"), asst("b1", "2026-11-03T09:00:00Z", U(100, 1000, 0, 7), [{ type: "text", text: "y" }], "claude-haiku-5-5"));
  fs.writeFileSync(path.join(x, "s3.jsonl"), asst("x1", "2026-11-03T09:00:00Z", U(1, 1, 1, 1), [{ type: "text", text: "z" }]));
  return { root, proj };
}
function run(proj, ...args) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "usage-cwd-"));   // no ledger here
  const r = cp.spawnSync(process.execPath, [CLI, "usage", "--projects", proj, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const J = (proj, ...args) => { const r = run(proj, ...args, "--json"); assert.equal(r.code, 0, r.err); return JSON.parse(r.out); };

test("usage: totals dedupe by message.id and skip synthetic", () => {
  const { proj } = fixture();
  const A = J(proj, "--project", "-work-alpha");
  assert.equal(A.turns.main, 3); assert.equal(A.turns.subagent, 2); assert.equal(A.turns.syntheticSkipped, 1);
  assert.equal(A.tokens.out, 50 + 20 + 10 + 10 + 10);   // m1 counts its last usage (50), not 5 + 50
  assert.equal(A.tokens.cc, 30000 + 100 + 200 + 25000 + 10);
  assert.equal(A.weightedTotal, Math.round(A.tokens.cr * 0.1 + A.tokens.cc * 1.25 + A.tokens.out * 5 + A.tokens.i));
  assert.equal(A.compactions.count, 1); assert.equal(A.compactions.maxPreTokens, 120000);
});

test("usage: --since and --until bound by timestamp date", () => {
  const { proj } = fixture();
  assert.equal(J(proj, "--project", "-work-alpha", "--until", "2026-11-01").turns.total, 2);
  assert.equal(J(proj, "--project", "-work-alpha", "--since", "2026-11-02").turns.total, 3);
  assert.equal(J(proj, "--since", "2026-11-02", "--until", "2026-11-02", "--project", "-work-alpha").turns.total, 3);
  const r = run(proj, "--since", "2026/11/02"); assert.equal(r.code, 2); assert.match(r.err, /YYYY-MM-DD/);
});

test("usage: --project filters and --exclude removes project directories", () => {
  const { proj } = fixture();
  assert.equal(J(proj).projectsRead, 3);
  assert.equal(J(proj, "--exclude", "alpha").projectsRead, 1);            // drops -work-alpha and -tmp-alpha-extra
  assert.deepEqual(J(proj, "--exclude", "alpha").byProject.map((p) => p.group), ["-work-beta"]);
  assert.equal(J(proj, "--project", "beta").turns.total, 1);
});

test("usage: works with no ledger, at most 40 lines for every view", () => {
  const { proj } = fixture();
  for (const args of [[], ["--waste"], ["--by", "session"], ["--by", "agent"], ["--by", "item"], ["--by", "kind"], ["--by", "model"], ["--price", "opus=1,sonnet=0.2,haiku=0.1"]]) {
    const r = run(proj, ...args); assert.equal(r.code, 0, args.join(" ") + r.err);
    assert.ok(r.out.trimEnd().split("\n").length <= 40, args.join(" "));
  }
});

test("usage: --by item splits a turn evenly over the ids of the most recent brief|stage|done", () => {
  const { proj } = fixture();
  const rows = J(proj, "--project", "-work-alpha", "--by", "item").groups.rows;
  const sec = rows.find((r) => r.group === "SEC-01"), wf = rows.find((r) => r.group === "WF-01"), none = rows.find((r) => r.group === "(no item)");
  assert.ok(sec && wf && none);
  assert.equal(sec.weighted, wf.weighted);
  assert.equal(sec.turns, 1.5);             // m1 (the brief turn), m2 and m3, each split in two
});

test("usage: --by kind has fixit; --by agent reads subagent meta", () => {
  const { proj } = fixture();
  const kinds = J(proj, "--project", "-work-alpha", "--by", "kind").groups.rows.map((r) => r.group);
  assert.ok(kinds.includes("fixit") && kinds.includes("git") && kinds.includes("ledger"));
  const kindRows = J(proj, "--project", "-work-alpha", "--by", "kind").groups.rows;
  assert.ok(kindRows.every((r) => r.avgCtx > 0 && r.peakCtx >= r.avgCtx && Number.isFinite(r.coldWrites)), "every kind row has its context figures");
  const agents = J(proj, "--project", "-work-alpha", "--by", "agent").groups.rows.map((r) => r.group);
  assert.ok(agents.includes("builder") && agents.includes("(main)"));
});

test("usage: kind order matches usage4.py, fixit first", () => {
  const { kindOf } = require("./usage.cjs");
  assert.equal(kindOf("fixit test api"), "fixit");
  assert.equal(kindOf("cd x && node remedy.cjs status"), "ledger");
  assert.equal(kindOf("npm test"), "test");
  assert.equal(kindOf("docker compose logs api"), "logs");
  assert.equal(kindOf("git log"), "git");
  assert.equal(kindOf("ls -la"), "read code");
  assert.equal(kindOf("echo hi"), "other");
  assert.equal(kindOf("cat fixit-plugin/README.md"), "read code");   // mentioning fixit is not a fixit call
});

test("usage: cold writes, reasons, waste signals and tool results", () => {
  const { proj } = fixture();
  const A = J(proj, "--project", "-work-alpha");
  assert.equal(A.coldWrites.byReason["first turn"].count, 2);        // m1 on the main file and s1 on the subagent
  assert.equal(A.waste.bashOutputOverCap.results, 1);
  assert.equal(A.toolResults.bashLargest > 20000, true);
  assert.equal(A.waste.overCeilingMain.turns, 0);
});

test("usage --waste: the model check compares only what transcripts record", () => {
  const { proj } = fixture();
  const m = J(proj, "--project", "-work-alpha").waste.modelCheck;
  assert.equal(m.agentCalls, 1); assert.equal(m.withRequestedModel, 1); assert.equal(m.comparable, 1);
  assert.equal(m.mismatches, 1);                  // asked for haiku, the subagent ran sonnet
  assert.equal(m.resolvedDiffersFromActual, 0);   // the harness's resolvedModel (sonnet) agrees with what ran
  const out = run(proj, "--project", "-work-alpha", "--waste").out;
  assert.match(out, /1 mismatched/); assert.match(out, /not in transcripts/);
});

test("usage: --price weights models; unpriced says so", () => {
  const { proj } = fixture();
  assert.match(run(proj).out, /unpriced/);
  const p = J(proj, "--price", "opus=1,sonnet=0.5,haiku=0.1");
  const u = J(proj);
  assert.ok(p.weightedTotal < u.weightedTotal);
  assert.equal(run(proj, "--price", "gpt=2").code, 2);
});

test("usage: unknown shapes fail clearly", () => {
  const { proj } = fixture();
  fs.writeFileSync(path.join(proj, "-work-beta", "bad.jsonl"), line({ type: "assistant", timestamp: "2026-11-03T10:00:00Z", message: { id: "q", usage: { tokens: 5 } } }));
  const r = run(proj, "--project", "beta");
  assert.equal(r.code, 2); assert.match(r.err, /unknown transcript shape/);
  const g = fs.mkdtempSync(path.join(os.tmpdir(), "usage-garbage-")); fs.mkdirSync(path.join(g, "p"));
  fs.writeFileSync(path.join(g, "p", "x.jsonl"), "not json\n".repeat(20));
  const r2 = run(g); assert.equal(r2.code, 2); assert.match(r2.err, /not JSON/);
  const e = fs.mkdtempSync(path.join(os.tmpdir(), "usage-empty-")); fs.mkdirSync(path.join(e, "p"));
  fs.writeFileSync(path.join(e, "p", "x.jsonl"), line({ type: "user", timestamp: "2026-11-03T10:00:00Z", message: { content: "hi" } }));
  const r3 = run(e); assert.equal(r3.code, 2); assert.match(r3.err, /no assistant turns/);
  assert.equal(run(path.join(g, "nope")).code, 2);
});

test("usage: listed in remedy help", () => {
  const r = cp.spawnSync(process.execPath, [CLI, "help"], { encoding: "utf8" });
  assert.match(r.stdout, /\n  usage \[--since D\]/);
});
