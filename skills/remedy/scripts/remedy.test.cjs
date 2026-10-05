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
