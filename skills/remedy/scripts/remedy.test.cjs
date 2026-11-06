// node --test skills/remedy/scripts/remedy.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const CLI = path.join(__dirname, "remedy.cjs");
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remedy-"));
  const run = (...args) => {
    const r = cp.spawnSync(process.execPath, [CLI, ...args, "--dir", path.join(root, ".remedy")], { cwd: root, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const ok = (...args) => { const r = run(...args); assert.equal(r.code, 0, `${args.join(" ")} failed: ${r.err || r.out}`); return r.out; };
  const json = (name, v) => { const p = path.join(root, name); fs.writeFileSync(p, JSON.stringify(v)); return p; };
  const item = (id) => JSON.parse(fs.readFileSync(path.join(root, ".remedy", "items", id + ".json"), "utf8"));
  const row = (k) => JSON.parse(fs.readFileSync(path.join(root, ".remedy", "register", k + ".json"), "utf8"));
  const plan = (id) => { const p = `docs/remediation/${id}.md`; fs.mkdirSync(path.join(root, "docs/remediation"), { recursive: true }); fs.writeFileSync(path.join(root, p), `# ${id}\n`); return p; };
  ok("init", "--title", "Test Tracker");
  return { root, run, ok, json, item, row, plan };
}

test("gate: an item cannot reach building without an approval", () => {
  const s = sandbox();
  s.ok("add-item", "--json", s.json("i.json", { id: "SEC-01", title: "Takeover", severity: "critical" }));
  const r = s.run("stage", "SEC-01", "building");
  assert.equal(r.code, 2);
  assert.match(r.err, /Gate closed/);
  assert.equal(s.item("SEC-01").stage, "backlog");
});

test("approve requires a plan, --by, and plan_review", () => {
  const s = sandbox();
  s.ok("add-item", "--json", s.json("i.json", { id: "SEC-01", title: "x" }));
  assert.match(s.run("approve", "SEC-01", "--by", "Owner").err, /no plan/);
  s.ok("set-plan", "SEC-01", "--path", s.plan("SEC-01"), "--summary", "fix it");
  assert.match(s.run("approve", "SEC-01").err, /--by/);
  s.ok("approve", "SEC-01", "--by", "Owner");
  const i = s.item("SEC-01");
  assert.equal(i.stage, "approved");
  assert.ok(i.plan.approvedAt);
  s.ok("stage", "SEC-01", "building");
  assert.equal(s.item("SEC-01").stage, "building");
});

test("stage refuses 'approved' (only approve can set it)", () => {
  const s = sandbox();
  s.ok("add-item", "--json", s.json("i.json", { id: "SEC-01", title: "x" }));
  s.ok("set-plan", "SEC-01", "--path", s.plan("SEC-01"), "--summary", "s");
  assert.match(s.run("stage", "SEC-01", "approved").err, /Use `approve`/);
});

test("revising an approved plan withdraws the approval", () => {
  const s = sandbox();
  s.ok("add-item", "--json", s.json("i.json", { id: "SEC-01", title: "x" }));
  const p = s.plan("SEC-01");
  s.ok("set-plan", "SEC-01", "--path", p, "--summary", "v1");
  s.ok("approve", "SEC-01", "--by", "Owner");
  const out = s.ok("set-plan", "SEC-01", "--path", p, "--summary", "v2");
  assert.match(out, /approval withdrawn/);
  const i = s.item("SEC-01");
  assert.equal(i.plan.approvedAt, "");
  assert.equal(i.stage, "plan_review");
});

test("set-plan refuses a plan file that does not exist", () => {
  const s = sandbox();
  s.ok("add-item", "--json", s.json("i.json", { id: "SEC-01", title: "x" }));
  assert.match(s.run("set-plan", "SEC-01", "--path", "docs/remediation/nope.md", "--summary", "s").err, /does not exist/);
});

test("ids are create-only and next-id skips taken and reserved ids", () => {
  const s = sandbox();
  s.ok("add-item", "--json", s.json("i.json", [{ id: "SEC-01", title: "a" }, { id: "SEC-02", title: "b" }]));
  assert.match(s.run("add-item", "--json", s.json("j.json", { id: "SEC-01", title: "dup" })).err, /already exists/);
  assert.equal(s.ok("next-id", "SEC").trim(), "SEC-03");
  s.ok("reserve", "SEC", "--from", "3", "--to", "9", "--owner", "other-session");
  assert.equal(s.ok("next-id", "SEC").trim(), "SEC-10");
  assert.match(s.run("reserve", "SEC", "--from", "5", "--to", "12").err, /overlaps/);
});

test("import-findings maps verdicts and dedupes by fingerprint", () => {
  const s = sandbox();
  const findings = [
    { verdict: "confirmed", fingerprint: "auth/otp-any-code", title: "OTP accepts any code", description: "d", root_cause: "rc", intended_behavior: "codes are checked",
      trace: [{ kind: "entrypoint", file: "src/a.ts", line: 10, scope: "auth", description: "route" }, { kind: "sink", file: "src/b.ts", line: 20, scope: "auth", description: "accept" }],
      evidence: [{ file: "src/b.ts", line: 20, description: "no compare" }], conditions: [], execution: {},
      remediation: { strategy: "compare the code" }, severity: { likelihood: { score: "high", reason: "r" }, impact: { score: "critical", reason: "takeover" }, overall_severity: "critical" },
      confidence: { score: "high", reason: "traced" } },
    { verdict: "needs_validation", fingerprint: "edge/cors", title: "CORS maybe open", description: "d", claimed_root_cause: "c", trace: [], evidence: [], blockers: ["proxy config not in repo"], validation_plan: { deployment: "check the proxy" } },
    { verdict: "rejected", fingerprint: "x", title: "t", description: "d", claimed_root_cause: "c", trace: [], evidence: [], reason: "no" },
  ];
  const f = s.json("findings.json", findings);
  const out = JSON.parse(s.ok("import-findings", f, "--prefix", "SEC"));
  assert.equal(out.created.length, 1);
  assert.equal(out.validation.length, 1);
  assert.equal(out.rejected, 1);
  const i = s.item("SEC-01");
  assert.equal(i.severity, "critical");
  assert.equal(i.wave, "W0");
  assert.equal(i.registerKey, "SEC-01");
  assert.equal(s.row("SEC-01").status, "open");
  assert.equal(s.item("SEC-02").kind, "validation");
  assert.equal(s.item("SEC-02").severity, "unrated");
  const again = JSON.parse(s.ok("import-findings", f));
  assert.equal(again.created.length, 0);
  assert.equal(again.carried.length, 2);
});

test("import-campaign maps layers to prefixes, keeps pinnedBy, dedupes, and rejects invalid entries", () => {
  const s = sandbox();
  const findings = [
    { fingerprint: "http/register-takeover", verdict: "confirmed", title: "Register returns another account's session", detail: "d", severity: "critical", layer: "http-authz", location: ["src/auth.ts:41"], pinnedBy: "auth.test.ts:411 (todo)", reproduction: "auth.test.ts › register existing email" },
    { fingerprint: "cap/inbox-scan", verdict: "confirmed", title: "Inbox rescans all history", detail: "d", severity: "high", layer: "capacity" },
    { fingerprint: "e2e/flaky-map", verdict: "lead", title: "Map flickers on resize", detail: "d", layer: "browser-e2e", blocker: "not reproduced headless" },
    { fingerprint: "bad", verdict: "confirmed", title: "no severity", detail: "d", layer: "static" },
  ];
  const f = s.json("cf.json", findings);
  const r = s.run("import-campaign", f);
  assert.equal(r.code, 1, "invalid entry makes the import exit non-zero");
  const out = JSON.parse(r.out);
  assert.equal(out.created.length, 2);
  assert.equal(out.leads.length, 1);
  assert.equal(out.invalid.length, 1);
  assert.equal(s.item("SEC-01").wave, "W0");
  assert.equal(s.item("SEC-01").pinnedBy, "auth.test.ts:411 (todo)");
  assert.match(s.row("SEC-01").foundBy, /HTTP/);
  assert.equal(s.item("PERF-01").kind, "perf");
  assert.equal(s.item("PERF-01").wave, "W2");
  assert.equal(s.item("WEB-01").kind, "validation");
  const again = JSON.parse(s.run("import-campaign", f).out);
  assert.equal(again.carried.length, 3);
  assert.equal(again.created.length, 0);
});

test("stage changes mirror onto the register row", () => {
  const s = sandbox();
  s.ok("add-row", "--json", s.json("r.json", { key: "SEC-01", title: "x", severity: "high" }));
  s.ok("add-item", "--json", s.json("i.json", { id: "SEC-01", title: "x", severity: "high", registerKey: "SEC-01" }));
  s.ok("set-plan", "SEC-01", "--path", s.plan("SEC-01"), "--summary", "s");
  s.ok("approve", "SEC-01", "--by", "Owner");
  s.ok("stage", "SEC-01", "building");
  assert.equal(s.row("SEC-01").status, "in_progress");
  s.ok("stage", "SEC-01", "in_review");
  assert.equal(s.row("SEC-01").status, "fix_in_review");
  s.ok("stage", "SEC-01", "done");
  assert.equal(s.row("SEC-01").status, "fixed");
});

test("validate catches gate bypasses, cluster drift and dangling register keys", () => {
  const s = sandbox();
  s.ok("add-item", "--json", s.json("i.json", { id: "SEC-01", title: "x", registerKey: "SEC-99" }));
  const p = path.join(s.root, ".remedy", "items", "SEC-01.json");
  const i = JSON.parse(fs.readFileSync(p, "utf8"));
  i.stage = "done"; i.cluster = "AUTH";
  fs.writeFileSync(p, JSON.stringify(i));
  const r = s.run("validate");
  assert.equal(r.code, 1);
  assert.match(r.out, /without a recorded plan approval/);
  assert.match(r.out, /registerKey SEC-99/);
  assert.match(r.out, /cluster AUTH is not in meta.clusters/);
});

test("cluster keeps item.cluster and meta.clusters in step", () => {
  const s = sandbox();
  s.ok("add-item", "--json", s.json("i.json", [{ id: "SEC-01", title: "a" }, { id: "SEC-02", title: "b" }]));
  s.ok("cluster", "AUTH", "--name", "Sign-in", "--items", "SEC-01,SEC-02");
  assert.equal(s.item("SEC-01").cluster, "AUTH");
  s.ok("cluster", "AUTH", "--remove", "SEC-02");
  assert.equal(s.item("SEC-02").cluster, "");
  const v = s.run("validate");
  assert.equal(v.code, 0, v.out);
});

test("render embeds the ledger into a self-contained page", () => {
  const s = sandbox();
  s.ok("add-item", "--json", s.json("i.json", { id: "SEC-01", title: "<script>alert(1)</script>" }));
  s.ok("render", "--out", path.join(s.root, "dash.html"));
  const html = fs.readFileSync(path.join(s.root, "dash.html"), "utf8");
  assert.match(html, /window.__REMEDY_DATA__=/);
  assert.ok(!html.includes("<script>alert(1)</script>"), "data must be escaped inside the script tag");
});

test("export-artifact writes collections for the live backend", () => {
  const s = sandbox();
  s.ok("add-item", "--json", s.json("i.json", { id: "SEC-01", title: "x" }));
  s.ok("export-artifact", "--out", path.join(s.root, "exp"));
  assert.ok(fs.existsSync(path.join(s.root, "exp", "items", "SEC-01.json")));
  assert.ok(fs.existsSync(path.join(s.root, "exp", "meta-protocol.json")));
});

// ───────────────────────────── init --settings ─────────────────────────────
function settingsSandbox(initial) {
  const s = sandbox();
  s.file = path.join(s.root, ".claude", "settings.json");
  if (initial !== undefined) { fs.mkdirSync(path.dirname(s.file), { recursive: true }); fs.writeFileSync(s.file, initial); }
  s.value = () => JSON.parse(fs.readFileSync(s.file, "utf8"));
  return s;
}

test("init --settings prints the diff and writes nothing without --apply", () => {
  const s = settingsSandbox();
  const out = s.ok("init", "--settings");
  assert.match(out, /\.claude\/settings\.json \(new file\)/);
  assert.match(out, /\+ autoCompactWindow: 150000/);
  assert.match(out, /\+ env\.BASH_MAX_OUTPUT_LENGTH: "10000"/);
  assert.match(out, /Nothing written/);
  assert.match(out, /\/context/);
  assert.equal(fs.existsSync(s.file), false);
  assert.equal(fs.existsSync(path.join(s.root, ".remedy", "settings-applied.json")), false);
});

test("init --settings --apply then --revert restores the file byte for byte", () => {
  const original = '{\n    "permissions": {"allow": ["Bash(make:*)"]},\n\n    "env": { "KEEP": "1" }\n}';
  const s = settingsSandbox(original);
  s.ok("init", "--settings", "--apply");
  const v = s.value();
  assert.equal(v.autoCompactWindow, 150000);
  assert.deepEqual(v.env, { KEEP: "1", BASH_MAX_OUTPUT_LENGTH: "10000" });
  assert.deepEqual(v.permissions, { allow: ["Bash(make:*)"] });
  assert.ok(fs.readFileSync(s.file, "utf8").startsWith('{\n    "permissions"'), "the file's indent is kept");
  s.ok("init", "--settings", "--revert");
  assert.equal(fs.readFileSync(s.file, "utf8"), original);
  assert.equal(fs.existsSync(path.join(s.root, ".remedy", "settings-applied.json")), false);
});

test("init --settings --revert removes a file that --apply created", () => {
  const s = settingsSandbox();
  s.ok("init", "--settings", "--apply");
  assert.ok(fs.readFileSync(s.file, "utf8").endsWith("}\n"));
  s.ok("init", "--settings", "--revert");
  assert.equal(fs.existsSync(s.file), false);
  assert.match(s.run("init", "--settings", "--revert").err, /Nothing to revert/);
});

test("init --settings keeps the owner's existing values and --revert leaves them", () => {
  const original = JSON.stringify({ autoCompactWindow: 200000 }, null, 2) + "\n";
  const s = settingsSandbox(original);
  const preview = s.ok("init", "--settings");
  assert.match(preview, /autoCompactWindow: keeping 200000 \(proposed 150000\)/);
  s.ok("init", "--settings", "--apply");
  assert.equal(s.value().autoCompactWindow, 200000);
  assert.equal(s.value().env.BASH_MAX_OUTPUT_LENGTH, "10000");
  s.ok("init", "--settings", "--revert");
  assert.equal(fs.readFileSync(s.file, "utf8"), original);
});

test("init --settings --revert after later edits removes only the keys it added", () => {
  const s = settingsSandbox('{\n  "theme": "dark"\n}\n');
  s.ok("init", "--settings", "--apply");
  const edited = s.value();
  edited.includeCoAuthoredBy = false;
  edited.autoCompactWindow = 300000;
  edited.env.OWNER = "x";
  fs.writeFileSync(s.file, JSON.stringify(edited, null, 2) + "\n");
  const out = s.ok("init", "--settings", "--revert");
  assert.match(out, /Left alone because their values changed: autoCompactWindow/);
  assert.deepEqual(s.value(), { theme: "dark", env: { OWNER: "x" }, autoCompactWindow: 300000, includeCoAuthoredBy: false });
});

test("init --settings --revert drops an env it created once that env is empty again", () => {
  const s = settingsSandbox('{\n  "theme": "dark"\n}\n');
  s.ok("init", "--settings", "--apply");
  const edited = s.value();
  edited.includeCoAuthoredBy = false;
  fs.writeFileSync(s.file, JSON.stringify(edited, null, 2) + "\n");
  s.ok("init", "--settings", "--revert");
  assert.deepEqual(s.value(), { theme: "dark", includeCoAuthoredBy: false });
});

test("init --settings --model adds the model and refuses anything but an alias", () => {
  const s = settingsSandbox();
  assert.match(s.ok("init", "--settings", "--model", "sonnet"), /\+ model: "sonnet"/);
  assert.equal(s.run("init", "--settings", "--model", "claude-sonnet-4-5-20250929").code, 2);
  assert.equal(s.run("init", "--settings", "--model", "inherit").code, 2);
  s.ok("init", "--settings", "--apply");
  assert.equal(s.value().model, undefined, "off by default");
  s.ok("init", "--settings", "--apply", "--model", "sonnet");
  assert.equal(s.value().model, "sonnet");
  s.ok("init", "--settings", "--revert");
  assert.equal(fs.existsSync(s.file), false, "a second --apply still reverts to the first state");
});

test("init --settings refuses settings it cannot parse and changes nothing", () => {
  for (const bad of ["{ not json", "[]", '{"env": "x"}']) {
    const s = settingsSandbox(bad);
    const r = s.run("init", "--settings", "--apply");
    assert.equal(r.code, 2, bad);
    assert.equal(fs.readFileSync(s.file, "utf8"), bad);
  }
});

test("init --settings works with no ledger, and init still works afterwards", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remedy-"));
  const dir = path.join(root, ".remedy");
  const run = (...args) => cp.spawnSync(process.execPath, [CLI, ...args, "--dir", dir], { cwd: root, encoding: "utf8" });
  assert.equal(run("init", "--settings", "--apply").status, 0);
  assert.ok(fs.existsSync(path.join(root, ".claude", "settings.json")));
  assert.equal(run("init", "--title", "T").status, 0);
  assert.equal(run("validate").status, 0, "settings-applied.json does not upset the ledger");
});

test("init --settings reports fresh context from the first turn of recent sessions", () => {
  const s = settingsSandbox();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "remedy-home-"));
  const dir = path.join(home, ".claude", "projects", s.root.replace(/[^A-Za-z0-9]/g, "-"));
  const turn = (input, read, write) => JSON.stringify({ type: "assistant", message: { usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write } } });
  fs.mkdirSync(path.join(dir, "sess", "subagents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "a.jsonl"), `not json\n${JSON.stringify({ type: "user" })}\n${turn(2, 30000, 20000)}\n${turn(1, 90000, 1)}\n`);
  fs.writeFileSync(path.join(dir, "sess", "subagents", "agent-1.jsonl"), turn(0, 0, 38000) + "\n");
  const r = cp.spawnSync(process.execPath, [CLI, "init", "--settings", "--dir", path.join(s.root, ".remedy")], { cwd: s.root, encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.match(r.stdout, /main 50k over 1, subagent 38k over 1/);
  const none = s.ok("init", "--settings");
  assert.match(none, /no recent sessions found/);
});

// ───────────── Phase 2: routing, brief, batch, worktrees, done, sync ─────────────
const route = require("./route.cjs");
const git = (cwd, ...a) => { const r = cp.spawnSync("git", a, { cwd, encoding: "utf8" }); assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
const GIT = ["-c", "user.email=t@t", "-c", "user.name=t"];
function repoSandbox() {
  const s = sandbox();
  git(s.root, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(s.root, "README"), "x");
  git(s.root, "add", "-A"); git(s.root, ...GIT, "commit", "-qm", "init");
  s.add = (o) => s.ok("add-item", "--json", s.json("i.json", o));
  s.meta = () => JSON.parse(fs.readFileSync(path.join(s.root, ".remedy", "meta.json"), "utf8"));
  s.setMeta = (m) => fs.writeFileSync(path.join(s.root, ".remedy", "meta.json"), JSON.stringify(m));
  s.write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(s.root, rel)), { recursive: true }); fs.writeFileSync(path.join(s.root, rel), text); return rel; };
  s.approved = (o, planPath) => { s.add(o); s.ok("set-plan", o.id, "--path", planPath || s.plan(o.id), "--summary", `summary of ${o.id}`); s.ok("approve", o.id, "--by", "Owner"); };
  s.snapshot = () => { const out = {}; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[p] = fs.readFileSync(p, "utf8"); } })(path.join(s.root, ".remedy")); return out; };
  return s;
}

test("route: the eight rules, first match wins", () => {
  const s = repoSandbox();
  s.setMeta({ ...s.meta(), models: { riskPaths: ["core/authz/"] } });
  const model = (id) => /model=(\w+)/.exec(s.ok("route", id))[1];
  s.add({ id: "SEC-01", title: "a", severity: "high" });
  s.add({ id: "WF-01", title: "b", severity: "medium" });
  s.add({ id: "FEAT-01", title: "c", severity: "unrated" });
  s.add({ id: "FEAT-02", title: "d", severity: "unrated" });
  s.add({ id: "FEAT-03", title: "e" });
  s.add({ id: "FEAT-04", title: "f", severity: "critical" });
  assert.equal(model("SEC-01"), "opus");
  assert.match(s.ok("route", "SEC-01"), /reason="severity high; prefix SEC"/);
  assert.equal(model("WF-01"), "sonnet");
  assert.equal(model("FEAT-01"), "sonnet");
  assert.equal(model("FEAT-04"), "opus");
  // risk
  s.ok("set-plan", "FEAT-01", "--path", s.plan("FEAT-01"), "--summary", "s", "--risk", "money");
  assert.equal(model("FEAT-01"), "opus");
  s.ok("set-plan", "FEAT-03", "--path", s.plan("FEAT-03"), "--summary", "s", "--risk", "mechanical");
  assert.equal(model("FEAT-03"), "haiku");
  assert.match(s.run("set-plan", "FEAT-03", "--path", s.plan("FEAT-03"), "--summary", "s", "--risk", "bogus").err, /--risk takes/);
  // riskPaths: the plan names a path under a prefix
  s.write("docs/remediation/FEAT-02.md", "# FEAT-02\n\n## Files\ncore/authz/scope.go\n");
  s.ok("set-plan", "FEAT-02", "--path", "docs/remediation/FEAT-02.md", "--summary", "s");
  assert.equal(model("FEAT-02"), "opus");
  // pin beats everything, escalation beats the rest, history is kept
  s.ok("route", "SEC-01", "--set", "haiku", "--by", "Owner", "--reason", "trial");
  assert.equal(model("SEC-01"), "haiku");
  assert.match(s.run("route", "WF-01", "--set", "haiku").err, /--by WHO and --reason/);
  assert.match(s.run("route", "WF-01", "--set", "claude-haiku-4-5-20251001", "--by", "o", "--reason", "r").err, /--set takes/);
  s.ok("escalate", "WF-01", "--reason", "same failure twice");
  assert.equal(model("WF-01"), "opus");
  assert.equal(s.item("WF-01").escalation.model, "opus");
  assert.ok(s.item("WF-01").history.some((h) => /Escalated/.test(h.action)));
  assert.equal(/model=(\w+)/.exec(s.ok("route", "--role", "planner"))[1], "opus");
  assert.match(s.ok("route", "--role", "tester"), /model=haiku effort=low turns=15/);
  assert.match(s.run("route", "--role", "nobody").err, /Unknown role/);
});

test("route.cjs: models override, effort, cluster takes the highest tier", () => {
  const item = { id: "WF-01", severity: "low" };
  assert.equal(route.resolveItem(item, { builder: "haiku" }).model, "haiku");
  assert.equal(route.resolveItem(item, { riskPrefixes: ["WF"] }).model, "opus");
  assert.equal(route.resolveItem(item, { effort: { sonnet: "high" } }).effort, "high");
  assert.equal(route.resolveItem({ ...item, risk: "mechanical" }, {}).mode, "mechanical");
  assert.equal(route.highest([route.resolveItem(item, {}), route.resolveItem({ id: "SEC-01" }, {})]).model, "opus");
  assert.deepEqual(route.checkModels({ builder: "sonnet", effort: { opus: "max" }, budgetUsd: 5 }), []);
  assert.equal(route.checkModels({ planner: "claude-opus-4-5-20251101" }).length, 1);
});

test("validate rejects a dated model id and an unknown risk, and groups repeats", () => {
  const s = repoSandbox();
  s.ok("validate");
  s.setMeta({ ...s.meta(), models: { builder: "claude-sonnet-4-5-20250929" } });
  const r = s.run("validate");
  assert.equal(r.code, 1);
  assert.match(r.out, /meta\.models\.builder .*dated/);
  s.setMeta({ ...s.meta(), models: { builder: "sonnet", effort: { opus: "high" } } });
  s.ok("validate");
  for (const id of ["A-01", "A-02", "A-03", "A-04"]) s.add({ id, title: id, severity: "low", risk: "nope", model: "gpt" });
  const g = s.run("validate");
  assert.equal(g.code, 1);
  assert.match(g.out, /ERROR 4 items \(A-01, A-02, A-03, …\): unknown risk nope/);
  assert.equal(s.run("validate", "--all").out.split("\n").filter((l) => /unknown risk/.test(l)).length, 4);
});

test("batch: 100 changes are one call and one summary line", () => {
  const s = repoSandbox();
  const ops = [];
  for (let n = 1; n <= 60; n++) { const id = `T-${String(n).padStart(2, "0")}`; ops.push({ op: "add-item", item: { id, title: `t ${n}`, severity: "low" } }); }
  for (let n = 1; n <= 40; n++) ops.push({ op: "note", id: `T-${String(n).padStart(2, "0")}`, text: `n${n}` });
  const out = s.ok("batch", s.json("b.json", { by: "remedy-triager", ops }));
  assert.equal(out.trim().split("\n").length, 1);
  assert.match(out, /^batch: 100 ops applied \(add-item 60, note 40\); 0 errors, 0 warnings/);
  assert.equal(s.item("T-40").note, "n40");
  assert.equal(s.item("T-40").history.at(-1).by, "remedy-triager");
  assert.equal(s.item("T-41").note, "");
});

test("batch: approve, an unknown op, or one gate refusal writes nothing", () => {
  const s = repoSandbox();
  s.add({ id: "SEC-01", title: "x" }); s.add({ id: "SEC-02", title: "y" });
  s.ok("set-plan", "SEC-01", "--path", s.plan("SEC-01"), "--summary", "s");
  const before = s.snapshot();
  const note = { op: "note", id: "SEC-02", text: "hello" };
  for (const [bad, re] of [[{ op: "approve", id: "SEC-01", by: "Owner" }, /approve is never allowed/], [{ op: "frobnicate", id: "SEC-01" }, /unknown op/], [{ op: "stage", id: "SEC-01", stage: "building" }, /Gate closed/], [{ op: "note", id: "NOPE-01", text: "x" }, /No item/]]) {
    const r = s.run("batch", s.json("b.json", { ops: [note, bad] }));
    assert.equal(r.code, 2, JSON.stringify(bad));
    assert.match(r.err, re);
    assert.deepEqual(s.snapshot(), before, "nothing written for " + bad.op);
  }
  const dry = s.run("batch", s.json("b.json", { ops: [note] }), "--dry-run");
  assert.equal(dry.code, 0);
  assert.match(dry.out, /would apply/);
  assert.deepEqual(s.snapshot(), before, "--dry-run writes nothing");
  // an op sees the ones before it, and a batch that breaks the ledger is refused at the end
  s.ok("batch", s.json("b.json", { ops: [{ op: "add-item", item: { id: "NEW-01", title: "n" } }, { op: "set-plan", id: "NEW-01", path: s.plan("NEW-01"), summary: "s", risk: "auth" }] }));
  assert.equal(s.item("NEW-01").stage, "plan_review");
  assert.equal(s.item("NEW-01").risk, "auth");
  const broken = s.run("batch", s.json("b.json", { ops: [{ op: "cluster", id: "C1", items: ["MISSING-01"] }] }));
  assert.equal(broken.code, 2);
  assert.match(broken.err, /validate:/);
});

test("stage with a comma list checks the gate for all first", () => {
  const s = repoSandbox();
  s.approved({ id: "SEC-01", title: "a" }); s.add({ id: "SEC-02", title: "b" }); s.approved({ id: "SEC-03", title: "c" });
  const before = s.snapshot();
  const r = s.run("stage", "SEC-01,SEC-02,SEC-03", "building");
  assert.equal(r.code, 2);
  assert.match(r.err, /1 of 3 refused, nothing changed/);
  assert.match(r.err, /SEC-02 can't move to building/);
  assert.deepEqual(s.snapshot(), before);
  assert.match(s.ok("stage", "SEC-01,SEC-03", "building"), /2 items → building/);
  assert.equal(s.item("SEC-03").stage, "building");
});

const CLUSTER_DOC = [
  "# GROUPA", "", "Items: SEC-01 · WF-01", "", "## Awaiting approval",
  "- **SEC-01 (high): the widget can fail.** " + "Long text. ".repeat(40),
  "  - **Fix:** check the input.", "  - **Test:** widget_test.go", "- **WF-01 (medium): second widget.** Clone it.", "", "## Other", "text",
].join("\n");

test("brief: gate closed gives exit 2 and no plan text; approved prints the section, wrapped within 40 lines", () => {
  const s = repoSandbox();
  s.write("docs/remediation/GROUPA.md", CLUSTER_DOC);
  s.add({ id: "SEC-01", title: "Fails", severity: "high", pinnedBy: "tests/a.test.ts › widget/fails", cluster: "GROUPA" });
  s.ok("set-plan", "SEC-01", "--path", "docs/remediation/GROUPA.md", "--summary", "Check input.");
  const closed = s.run("brief", "SEC-01");
  assert.equal(closed.code, 2);
  assert.match(closed.err, /GATE CLOSED/);
  assert.doesNotMatch(closed.out + closed.err, /check the input/);
  s.ok("approve", "SEC-01", "--by", "Owner");
  const out = s.ok("brief", "SEC-01");
  const lines = out.trimEnd().split("\n");
  assert.ok(lines.length <= 40 && lines.every((l) => l.length <= 200), `${lines.length} lines`);
  assert.match(out, /route: agent=fixit-plugin:remedy-builder model=opus effort=high turns=60 reason="severity high; prefix SEC"/);
  assert.match(out, /plan: docs\/remediation\/GROUPA\.md lines 6-8 \(section only; whole doc 12 lines\)/);
  assert.match(out, /Fix:\*\* check the input/);
  assert.doesNotMatch(out, /WF-01 \(medium\)/);
  assert.match(out, /summary: Check input\./);
  assert.match(out, /pinned: fixit test tests\/a\.test\.ts --grep "widget\/fails"/);
  assert.match(out, /finish: remedy report SEC-01 {3}\| {3}remedy done SEC-01 --commit <sha>/);
  assert.equal(JSON.parse(s.ok("brief", "SEC-01", "--json")).route.model, "opus");
});

test("brief: per-item plan, overview plan, truncation pointer, missing section, pinned forms", () => {
  const s = repoSandbox();
  s.write("docs/remediation/WF-01.md", "# WF-01: t\n\n## Root cause\nrc text\n\n## Fix\n1. do it\n\n## Files\ncore/x.go\n\n## Tests\n- a test\n\n## Acceptance\nworks\n");
  s.approved({ id: "WF-01", title: "per item" }, "docs/remediation/WF-01.md");
  const per = s.ok("brief", "WF-01");
  assert.match(per, /sections Fix, Files, Tests, Acceptance/);
  assert.match(per, /1\. do it/);
  assert.match(per, /rc text/, "root cause only when there is room");
  s.write("docs/remediation/OV.md", "# Overview\nshort\n");
  s.approved({ id: "WF-02", title: "overview" }, "docs/remediation/OV.md");
  const ov = s.ok("brief", "WF-02");
  assert.match(ov, /summary: summary of WF-02/);
  assert.match(ov, /overview; the plan is the summary above/);
  s.write("docs/remediation/BIG.md", ["# Big", ...Array.from({ length: 60 }, (_, n) => `line ${n}`)].join("\n"));
  s.approved({ id: "WF-03", title: "missing" }, "docs/remediation/BIG.md");
  assert.match(s.ok("brief", "WF-03"), /SECTION NOT FOUND: read docs\/remediation\/BIG\.md/);
  const bigSec = ["# Big", "## WF-04 sec", ...Array.from({ length: 80 }, (_, n) => `sec line ${n}`)].join("\n");
  s.write("docs/remediation/BIG2.md", bigSec);
  s.approved({ id: "WF-04", title: "long" }, "docs/remediation/BIG2.md");
  const long = s.ok("brief", "WF-04");
  assert.ok(long.trimEnd().split("\n").length <= 40);
  assert.match(long, /\+\d+ lines: sed -n '\d+,82p' docs\/remediation\/BIG2\.md/);
  for (const [pinned, want] of [["a/b.test.ts · name here (it.fails)", 'fixit test a/b.test.ts --grep "name here"'], ["a/b.test.ts (the name / marker)", 'fixit test a/b.test.ts --grep "the name"'], ["free text", "pinned: free text"]]) {
    const s2 = repoSandbox();
    s2.approved({ id: "WF-09", title: "p", pinnedBy: pinned });
    assert.ok(s2.ok("brief", "WF-09").includes(want), pinned);
  }
  const blocked = repoSandbox();
  blocked.add({ id: "D-01", title: "dep" });
  blocked.approved({ id: "WF-10", title: "b", dependsOn: ["D-01"] });
  assert.match(blocked.ok("brief", "WF-10"), /depends: D-01 backlog BLOCKED/);
  assert.match(s.ok("brief", "WF-01", "--role", "planner"), /route: agent=fixit-plugin:remedy-planner model=opus/);
});

test("status: at most 20 lines and 1,500 characters on a big ledger; --ids, --clusters, --cluster, --json", () => {
  const s = repoSandbox();
  const ops = [];
  for (let c = 1; c <= 50; c++) for (let n = 1; n <= 4; n++) { const id = `X${c}-${String(n).padStart(2, "0")}`; ops.push({ op: "add-item", item: { id, title: `item ${id} with a reasonably long title to pad the output`, cluster: `CL${c}`, severity: "low" } }); }
  s.ok("batch", s.json("b.json", { ops }));
  for (let c = 1; c <= 12; c++) { s.write(`docs/remediation/CL${c}.md`, "x"); s.ok("set-plan", `X${c}-01`, "--path", `docs/remediation/CL${c}.md`, "--summary", "s"); s.ok("approve", `X${c}-01`, "--by", "o"); }
  const out = s.ok("status");
  assert.ok(out.trimEnd().split("\n").length <= 20 && out.length <= 1500, `${out.split("\n").length} lines, ${out.length} chars`);
  assert.match(out, /\+4 more clusters with active work/);
  assert.ok(s.ok("status", "--clusters").split("\n").length > 50);
  assert.match(s.ok("status", "--ids"), /Approved, not yet built: X1-01/);
  assert.equal(s.ok("status", "--cluster", "CL1").trim().split("\n").length, 5);
  assert.equal(JSON.parse(s.ok("status", "--json")).items, 200);
  assert.match(s.ok("status", "--render"), /unresolved/);
  assert.ok(fs.existsSync(path.join(s.root, ".remedy", "dashboard.html")));
});

test("worktree: status and stage read and write the main checkout's ledger", () => {
  const s = repoSandbox();
  s.approved({ id: "SEC-01", title: "x" });
  git(s.root, "add", "-A"); git(s.root, ...GIT, "commit", "-qm", "ledger");
  const wt = path.join(path.dirname(s.root), path.basename(s.root) + "-wt");
  git(s.root, "worktree", "add", "-q", wt, "-b", "fix/sec-01");
  assert.ok(fs.existsSync(path.join(wt, ".remedy", "items", "SEC-01.json")), "the worktree has its own tracked copy");
  const inWt = (...a) => cp.spawnSync(process.execPath, [CLI, ...a], { cwd: wt, encoding: "utf8", env: { ...process.env, REMEDY_DIR: "" } });
  const r = inWt("stage", "SEC-01", "building");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.item("SEC-01").stage, "building", "main checkout changed");
  assert.equal(JSON.parse(fs.readFileSync(path.join(wt, ".remedy", "items", "SEC-01.json"), "utf8")).stage, "approved", "the worktree's own copy did not");
  assert.match(inWt("status").stdout, /building: 1/);
  assert.ok(/SEC-01 building|building:1/.test(inWt("status").stdout));
  assert.match(inWt("report", "SEC-01", "--show").stderr, /No report at \.remedy\/runs/);
  const rep = cp.spawnSync(process.execPath, [CLI, "report", "SEC-01"], { cwd: wt, input: "status: handoff\nnext: x\n", encoding: "utf8" });
  assert.equal(rep.status, 0, rep.stderr);
  assert.ok(fs.existsSync(path.join(s.root, ".remedy", "runs", "SEC-01.md")), "report lands in the main checkout");
  assert.match(inWt("report", "SEC-01", "--show").stdout, /status: handoff/);
});

test("done: merged goes to done, unmerged to in_review; the register follows", () => {
  const s = repoSandbox();
  s.ok("add-row", "--json", s.json("r.json", { key: "SEC-01", title: "x", severity: "high" }));
  s.approved({ id: "SEC-01", title: "x", registerKey: "SEC-01" });
  s.approved({ id: "SEC-02", title: "y" });
  s.ok("stage", "SEC-01,SEC-02", "building");
  git(s.root, "add", "-A"); git(s.root, ...GIT, "commit", "-qm", "ledger");
  git(s.root, "checkout", "-q", "-b", "fix/x");
  fs.writeFileSync(path.join(s.root, "f"), "1"); git(s.root, "add", "-A"); git(s.root, ...GIT, "commit", "-qm", "fix");
  const sha = git(s.root, "rev-parse", "HEAD");
  const out = s.ok("done", "SEC-01", "--commit", sha);
  assert.match(out, /^SEC-01: building → in_review at [0-9a-f]{7} \(not on main\); 0 errors; dashboard written/);
  assert.equal(s.row("SEC-01").status, "fix_in_review");
  git(s.root, "checkout", "-q", "main"); git(s.root, ...GIT, "merge", "-q", "--ff-only", "fix/x");
  assert.match(s.ok("done", "SEC-01,SEC-02", "--commit", sha), /SEC-01: in_review → done[\s\S]*SEC-02: building → done/);
  assert.equal(s.item("SEC-01").stage, "done");
  assert.equal(s.row("SEC-01").status, "fixed");
  assert.match(s.run("done", "SEC-01", "--commit", "deadbeef").err, /not found/);
  s.setMeta({ ...s.meta(), mainBranch: "nope" });
  s.add({ id: "SEC-03", title: "z" });
  assert.match(s.run("done", "SEC-02", "--commit", sha).err, /refus|nothing changed|Cannot compare/);
});

test("done warns when no green fixit run covers the pinned test", () => {
  const s = repoSandbox();
  s.approved({ id: "SEC-01", title: "x", pinnedBy: "tests/a.test.ts › the test" });
  s.ok("stage", "SEC-01", "building");
  git(s.root, "add", "-A"); git(s.root, ...GIT, "commit", "-qm", "l");
  const sha = git(s.root, "rev-parse", "HEAD");
  assert.match(s.ok("done", "SEC-01", "--commit", sha), /warn: no green fixit run found/);
  s.approved({ id: "SEC-02", title: "y", pinnedBy: "tests/b.test.ts › t2" });
  s.ok("stage", "SEC-02", "building");
  fs.mkdirSync(path.join(s.root, ".fixit", "runs", "r1"), { recursive: true });
  fs.writeFileSync(path.join(s.root, ".fixit", "runs", "r1", "meta.json"), JSON.stringify({ exitCode: 0, result: "pass", target: "tests/b.test.ts", files: ["tests/b.test.ts"] }));
  assert.doesNotMatch(s.ok("done", "SEC-02", "--commit", sha), /warn/);
});

test("show omits history unless asked", () => {
  const s = repoSandbox();
  s.add({ id: "SEC-01", title: "x" });
  const lean = JSON.parse(s.ok("show", "SEC-01"));
  assert.equal(lean.item.history, undefined);
  assert.equal(lean.item.historyEntries, 1);
  assert.equal(JSON.parse(s.ok("show", "SEC-01", "--history")).item.history.length, 1);
});

test("sync is one line; publish --prepare sends only changed documents", () => {
  const s = repoSandbox();
  s.add({ id: "SEC-01", title: "x" }); s.add({ id: "SEC-02", title: "y" });
  const line = s.ok("sync");
  assert.equal(line.trim().split("\n").length, 1);
  assert.match(line, /^sync: 0 register row\(s\) mirrored; 0 errors, 0 warnings; dashboard written/);
  const out = path.join(s.root, "pub");
  assert.match(s.run("publish", "--prepare", "--out", out).err, /No live tracker/);
  s.setMeta({ ...s.meta(), publish: { trackerUrl: "https://claude.ai/artifact/abc", registerUrl: "" } });
  assert.match(s.ok("publish", "--prepare", "--out", out), /^3 changed, 1 batches, /);
  const b = JSON.parse(fs.readFileSync(path.join(out, "batch-001.json"), "utf8"));
  assert.equal(b.url, "https://claude.ai/artifact/abc");
  assert.deepEqual(b.writes.map((w) => `${w.collection}/${w.doc_id}`).sort(), ["items/SEC-01", "items/SEC-02", "meta/protocol"]);
  assert.equal(JSON.parse(fs.readFileSync(b.writes[0].file_path, "utf8")).title.length > 0, true);
  assert.match(s.ok("publish", "--prepare", "--out", out), /^3 changed/, "nothing committed yet, so everything is still pending");
  assert.match(s.ok("sync", "--artifact-commit"), /manifest updated for 3 document/);
  assert.match(s.ok("publish", "--prepare", "--out", out), /^0 changed, 0 batches/);
  s.ok("note", "SEC-02", "edited");
  assert.match(s.ok("sync", "--artifact-prepare", "--out", out), /; 1 changed, 1 batches/);
  const b2 = JSON.parse(fs.readFileSync(path.join(out, "batch-001.json"), "utf8"));
  assert.deepEqual(b2.existing, ["items/SEC-02"], "an update names the document that needs if_version");
  for (let n = 3; n <= 120; n++) s.add({ id: `B-${String(n).padStart(2, "0")}`, title: "b" });
  assert.match(s.ok("publish", "--prepare", "--out", out), /^119 changed, 3 batches/);
});

test("the meta lock: a stale lock is cleared, and the lock file does not outlive the write", () => {
  const s = repoSandbox();
  const lock = path.join(s.root, ".remedy", "meta.json.lock");
  fs.writeFileSync(lock, "");
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  s.ok("reserve", "SEC", "--from", "1", "--to", "5", "--owner", "me");
  assert.ok(!fs.existsSync(lock));
  assert.equal(s.meta().reservedIds.length, 1);
});

test("new item fields survive add-item and the old CLI still reads the new files", () => {
  const s = repoSandbox();
  s.add({ id: "SEC-01", title: "x", risk: "auth", model: "opus", escalation: { model: "opus", reason: "r", at: "2026-01-01T00:00:00Z" }, cost: { usd: 1.5, turns: 10, runs: 1 } });
  const i = s.item("SEC-01");
  assert.deepEqual([i.risk, i.model, i.escalation.model, i.cost.usd], ["auth", "opus", "opus", 1.5]);
  const old = cp.spawnSync("git", ["show", "039567c:skills/remedy/scripts/remedy.cjs"], { cwd: __dirname, encoding: "utf8" });
  if (old.status !== 0) return; // the brief's commit is not in this clone
  const oldCli = path.join(s.root, "old-remedy.cjs");
  fs.writeFileSync(oldCli, old.stdout);
  const run = (...a) => cp.spawnSync(process.execPath, [oldCli, ...a, "--dir", path.join(s.root, ".remedy")], { cwd: s.root, encoding: "utf8" });
  assert.equal(run("status").status, 0);
  assert.equal(run("validate").status, 0);
  assert.equal(JSON.parse(run("show", "SEC-01").stdout).item.risk, "auth");
  assert.equal(run("note", "SEC-01", "from old").status, 0);
  assert.equal(s.item("SEC-01").risk, "auth", "the old CLI keeps fields it does not know");
});

test("set-plan records pinnedBy and dependsOn, from flags and from a batch op", () => {
  const s = sandbox();
  s.ok("add-item", "--json", s.json("a.json", { id: "WF-01", title: "a" }));
  s.ok("add-item", "--json", s.json("b.json", { id: "WF-02", title: "b" }));
  s.ok("set-plan", "WF-01", "--path", s.plan("WF-01"), "--summary", "s", "--pinned-by", "t/a.test.ts › case a", "--depends-on", "WF-02");
  assert.equal(s.item("WF-01").pinnedBy, "t/a.test.ts › case a");
  assert.deepEqual(s.item("WF-01").dependsOn, ["WF-02"]);
  s.ok("batch", s.json("op.json", { by: "t", ops: [{ op: "set-plan", id: "WF-02", path: s.plan("WF-02"), summary: "s", pinnedBy: "t/b.test.ts › case b", dependsOn: ["WF-01"] }] }));
  assert.equal(s.item("WF-02").pinnedBy, "t/b.test.ts › case b");
  assert.deepEqual(s.item("WF-02").dependsOn, ["WF-01"]);
  s.ok("set-plan", "WF-01", "--path", s.plan("WF-01"), "--summary", "s2");
  assert.equal(s.item("WF-01").pinnedBy, "t/a.test.ts › case a", "a later set-plan without the flag keeps them");
});

test("brief parses pinnedBy written as 'path (name)'", () => {
  const s = sandbox();
  s.ok("add-item", "--json", s.json("a.json", { id: "WF-01", title: "a", pinnedBy: "t/a.test.ts (case a)" }));
  s.ok("set-plan", "WF-01", "--path", s.plan("WF-01"), "--summary", "s");
  s.ok("approve", "WF-01", "--by", "Owner");
  assert.match(s.ok("brief", "WF-01"), /pinned: fixit test t\/a\.test\.ts --grep "case a"/);
});

test("handoff writes counts, in-flight items, reports since the last one, next step and questions; --latest prints the newest", () => {
  const s = sandbox();
  cp.execFileSync("git", ["init", "-q", s.root]);
  assert.match(s.ok("handoff", "--latest"), /no handoff yet/);
  s.ok("add-item", "--json", s.json("a.json", { id: "APP-01", title: "First thing" }));
  s.ok("add-item", "--json", s.json("b.json", { id: "APP-02", title: "Second thing" }));
  s.ok("set-plan", "APP-01", "--path", s.plan("APP-01"), "--summary", "s");
  s.ok("approve", "APP-01", "--by", "owner");
  s.ok("stage", "APP-01", "building");
  fs.mkdirSync(path.join(s.root, ".remedy", "runs"), { recursive: true });
  fs.writeFileSync(path.join(s.root, ".remedy", "runs", "APP-01.md"), "status: stuck\nbranch: fix/app-01\ncommit: abc1234\n");
  const out = s.ok("handoff", "--next", "fresh builder on APP-01", "--open", "keep the old API?", "--open", "which base?");
  assert.match(out, /^handoff: \.remedy\/handoff\/\d{4}-\d{2}-\d{2}-\d{4}\.md \(\d+ lines\)\nresume: .*remedy handoff --latest\n$/);
  const first = fs.readdirSync(path.join(s.root, ".remedy", "handoff"))[0];
  assert.ok(first);
  const text = s.ok("handoff", "--latest");
  assert.match(text, /stages: backlog 1, building 1/);
  assert.match(text, /- APP-01 building: branch fix\/app-01, commit abc1234, report says stuck\. First thing/);
  assert.match(text, /- APP-01: stuck, remedy report APP-01 --show/);
  assert.match(text, /## Next step\nfresh builder on APP-01/);
  assert.match(text, /- keep the old API\?\n- which base\?/);
  // The same minute does not overwrite, and a report already handed over is not listed again.
  const again = s.ok("handoff", "--next", "second");
  assert.match(again, /-2\.md/);
  const latest = s.ok("handoff", "--latest");
  assert.match(latest, /## Next step\nsecond/);
  assert.match(latest, /## Run reports since the last handoff\n- none/);
  const from = cp.spawnSync(process.execPath, [CLI, "handoff", "--from", "-", "--dir", path.join(s.root, ".remedy")], { cwd: s.root, encoding: "utf8", input: "Next: do the rest\nAsk: which base\n" });
  assert.equal(from.status, 0, from.stderr);
  const fromLead = s.ok("handoff", "--latest");
  assert.match(fromLead, /## From the lead\nNext: do the rest\nAsk: which base/);
  assert.doesNotMatch(fromLead, /none given/);
});

test("handoff --latest prints at most 60 lines and says where the rest is", () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.root, ".remedy", "handoff"), { recursive: true });
  fs.writeFileSync(path.join(s.root, ".remedy", "handoff", "2026-01-01-0000.md"), Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n") + "\n");
  const ls = s.ok("handoff", "--latest").trimEnd().split("\n");
  assert.equal(ls.length, 61);
  assert.match(ls[60], /^\+20 lines: sed -n '61,80p' \.remedy\/handoff\/2026-01-01-0000\.md$/);
});

test("init ignores raw run results in the ledger's own .gitignore, adding to one that is there", () => {
  const s = sandbox();
  assert.equal(fs.readFileSync(path.join(s.root, ".remedy", ".gitignore"), "utf8"), "runs/*.json\n");
  assert.equal(fs.existsSync(path.join(s.root, ".gitignore")), false, "the project's own file is not created");
});
