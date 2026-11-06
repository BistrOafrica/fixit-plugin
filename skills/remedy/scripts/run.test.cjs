// node --test skills/remedy/scripts/run.test.cjs
// A stand-in `claude` on PATH records its arguments and plays a scripted worker, so no model is called. What these show
// is the script's behaviour; that the real claude honours the flags is a live question, not tested here.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const RUN = require("./run.cjs");

const CLI = path.join(__dirname, "remedy.cjs");
const SRC = fs.readFileSync(path.join(__dirname, "run.cjs"), "utf8");
const GIT = ["-c", "user.email=t@example.com", "-c", "user.name=t"];
const git = (cwd, ...a) => { const r = cp.spawnSync("git", [...GIT, ...a], { cwd, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const ok = { subtype: "success", is_error: false, total_cost_usd: 0.25, num_turns: 7, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 } };

const STUB = `#!/usr/bin/env node
const fs = require("fs"), cp = require("child_process"), path = require("path");
const dir = process.env.STUB_DIR, spec = path.join(dir, "scenario.json");
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(),
  env: Object.fromEntries(["FIXIT_RUN_ID", "REMEDY_RUN_ITEM", "REMEDY_DIR", "CLAUDE_CODE_AUTO_COMPACT_WINDOW"].map((k) => [k, process.env[k]])), path: process.env.PATH }) + "\\n");
const all = JSON.parse(fs.readFileSync(spec, "utf8")), step = all.shift() || {};
fs.writeFileSync(spec, JSON.stringify(all));
if (step.sh) { const r = cp.spawnSync("sh", ["-c", step.sh], { encoding: "utf8" }); fs.appendFileSync(path.join(dir, "sh.log"), r.stdout + r.stderr); }
if (step.out !== undefined) process.stdout.write(step.out);
else if (step.result !== null) process.stdout.write(JSON.stringify(step.result || ${JSON.stringify(ok)}));
process.exit(step.exit || 0);
`;

function project({ items = [["SCR-01", {}]], config, models, scenario = [] } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "run-")));
  const stub = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "run-stub-")));
  git(root, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(stub, "claude"), STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(stub, "scenario.json"), JSON.stringify(scenario));
  const env = { ...process.env, PATH: stub + path.delimiter + process.env.PATH, STUB_DIR: stub };
  for (const k of ["FIXIT_RUN_ID", "REMEDY_RUN_ITEM", "REMEDY_DIR", "FIXIT_DIR"]) delete env[k];
  const remedy = (...args) => { const r = cp.spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", env, input: "" }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  assert.equal(remedy("init", "--title", "T").code, 0);
  fs.writeFileSync(path.join(root, "app.txt"), "one\n");
  if (config) fs.writeFileSync(path.join(root, "fixit.config.json"), JSON.stringify(config));
  if (models) { const f = path.join(root, ".remedy/meta.json"), m = JSON.parse(fs.readFileSync(f, "utf8")); m.models = models; fs.writeFileSync(f, JSON.stringify(m)); }
  for (const [id, o] of items) {
    const { approve = true, ...fields } = o;
    fs.writeFileSync(path.join(root, "docs/remediation", id + ".md"), `# ${id}\nA plan.\n`);
    const j = path.join(stub, id + ".json"); fs.writeFileSync(j, JSON.stringify({ id, title: "A task", ...fields }));
    assert.equal(remedy("add-item", "--json", j).code, 0);
    assert.equal(remedy("set-plan", id, "--path", `docs/remediation/${id}.md`, "--summary", "do it").code, 0);
    if (approve) assert.equal(remedy("approve", id, "--by", "the owner").code, 0);
  }
  git(root, "add", "-A"); git(root, "commit", "-qm", "base");
  const calls = () => { const f = path.join(stub, "calls.jsonl"); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []; };
  const item = (id) => JSON.parse(fs.readFileSync(path.join(root, ".remedy/items", id + ".json"), "utf8"));
  const scene = (s) => fs.writeFileSync(path.join(stub, "scenario.json"), JSON.stringify(s));
  const report = (id) => fs.readFileSync(path.join(root, ".remedy/runs", id + ".md"), "utf8");
  return { root, stub, env, remedy, calls, item, scene, report, wt: (id) => path.join(root, ".fixit/worktrees", id) };
}
const lines = (s) => s.trimEnd().split("\n");
const flag = (argv, f) => argv[argv.indexOf(f) + 1];
const listOf = (argv, f) => { const a = argv.indexOf(f), rest = argv.slice(a + 1), e = rest.findIndex((x) => x.startsWith("--")); return e < 0 ? rest : rest.slice(0, e); };

test("the allowlist names remedy's subcommands one by one: no wildcard across remedy, never approve", () => {
  const remedyRules = RUN.RUN_ALLOW.filter((r) => /remedy/.test(r));
  assert.equal(remedyRules.length, RUN.REMEDY_ALLOW.length);
  for (const r of remedyRules) assert.match(r, /^Bash\(remedy [a-z-]+:\*\)$/, r);
  for (const r of RUN.RUN_ALLOW) {
    assert.doesNotMatch(r, /approve|set-plan|request-changes|batch|escalate|\broute\b/, r);
    assert.doesNotMatch(r, /^Bash\(\s*(remedy\s*[*:]|\*)/, r);
    assert.doesNotMatch(r, /^Bash\((node|bash|sh|zsh|python\d*|perl|ruby|env|xargs|eval|sudo)\b/, r);
    assert.notEqual(r, "Bash");
    assert.notEqual(r, "Edit", "a bare Edit rule would reach any file, the main ledger included");
    assert.notEqual(r, "Write");
    assert.doesNotMatch(r, /^Bash\(git(:\*| \*)\)$/, "git -c runs anything");
    assert.doesNotMatch(r, /^Bash\(fixit(:\*| \*)\)$/);
  }
  for (const s of ["approve", "set-plan", "request-changes", "route", "batch", "escalate"]) assert.ok(RUN.RUN_DENY.includes(`Bash(remedy ${s}:*)`), s);
  assert.ok(RUN.RUN_DENY.includes("Bash(git push:*)"));
});

test("the worker never gets a permission-bypass flag, and print mode is told not to ask", () => {
  const args = RUN.buildArgs({ prompt: "x", r: { agent: "a", model: "sonnet", effort: "low" }, turns: 3, budget: 1, main: "/m", planDir: "docs/remediation", allow: [] });
  assert.equal(flag(args, "--permission-mode"), "dontAsk");
  assert.doesNotMatch(args.join(" "), /skip-permissions|bypassPermissions|acceptEdits|allow-dangerously/);
  const code = SRC.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.doesNotMatch(code, /dangerously|bypassPermissions/);
  assert.deepEqual(listOf(args, "--allowedTools").filter((r) => /^Read\(\/\//.test(r)), ["Read(//m/.fixit/runs/**)", "Read(//m/docs/remediation/**)"]);
  assert.ok(listOf(args, "--disallowedTools").includes("Write(//m/.remedy/**)"));
});

test("run.allow in fixit.config.json takes narrow rules and refuses anything that opens the gate or arbitrary execution", () => {
  for (const r of ["Bash(go build:*)", "Bash(make lint)", "Bash(pnpm install)", "Bash(node scripts/lint.js)", "Bash(go vet ./...)"]) assert.equal(RUN.projectRuleProblem(r), null, r);
  for (const r of ["Bash", "Bash(*)", "Bash(:*)", "Bash( * )", "Edit", "Write(./**)", "WebFetch", "mcp__x__y", "Bash(remedy brief:*)", "Bash(remedy:*)", "Bash(remedy *)", "Bash(fixit clean:*)", "Bash(x approve:*)", "Bash(node *)", "Bash(node:*)", "Bash(bash *)", "Bash(sh:*)", "Bash(python3 *)", "Bash(git *)", "Bash(git:*)", "Bash(env *)", "Bash(xargs *)", "Bash(sudo make:*)", "Bash(npx *)", "Bash(make x; rm y)", "Bash(make x && y)", "Bash(make $(x))", 7, null]) assert.ok(RUN.projectRuleProblem(r), String(r));
});

test("refuses an unapproved item, and starts nothing", () => {
  const p = project({ items: [["SCR-01", { approve: false }]] });
  const before = fs.readFileSync(path.join(p.root, ".remedy/items/SCR-01.json"), "utf8");
  const r = p.remedy("run", "SCR-01", "--max-budget-usd", "1");
  assert.equal(r.code, 2);
  assert.match(r.err, /GATE CLOSED/);
  assert.deepEqual(p.calls(), [], "no process");
  assert.equal(fs.existsSync(p.wt("SCR-01")), false, "no worktree");
  assert.equal(fs.existsSync(path.join(p.root, ".fixit")), false);
  assert.equal(fs.readFileSync(path.join(p.root, ".remedy/items/SCR-01.json"), "utf8"), before, "the item is unchanged");
  assert.equal(p.remedy("run", "SCR-01", "--max-budget-usd", "1", "--dry-run").code, 2, "--dry-run refuses too");
});

test("the approval is read from the plan, not assumed from the stage; a forged stage is refused", () => {
  const p = project({ items: [["SCR-01", { approve: false }]] });
  const f = path.join(p.root, ".remedy/items/SCR-01.json"), i = p.item("SCR-01");
  i.stage = "approved"; fs.writeFileSync(f, JSON.stringify(i));
  const r = p.remedy("run", "SCR-01", "--max-budget-usd", "1");
  assert.equal(r.code, 2); assert.match(r.err, /GATE CLOSED/); assert.deepEqual(p.calls(), []);
});

test("no budget, no run: there is no default, and nothing starts", () => {
  const p = project();
  for (const args of [[], ["--max-budget-usd"], ["--max-budget-usd", "0"], ["--max-budget-usd", "-1"], ["--max-budget-usd", "lots"]]) {
    const r = p.remedy("run", "SCR-01", ...args);
    assert.equal(r.code, 2, args.join(" ")); assert.match(r.err, /no default budget/);
  }
  assert.deepEqual(p.calls(), []);
  assert.equal(p.item("SCR-01").stage, "approved");
  const q = project({ models: { budgetUsd: 0.5 }, scenario: [{ sh: "printf 'status: handoff\\n' | remedy report SCR-01" }] });
  q.remedy("run", "SCR-01");
  assert.equal(flag(q.calls()[0].argv, "--max-budget-usd"), "0.5", "models.budgetUsd is the only other source");
});

test("refuses a wrong stage, an unfinished dependency and a bad flag, starting nothing", () => {
  const p = project({ items: [["SCR-01", {}], ["SCR-02", { dependsOn: ["SCR-01"] }], ["SCR-03", { dependsOn: ["SCR-99"] }]] });
  assert.match(p.remedy("run", "SCR-02", "--max-budget-usd", "1").err, /depends on SCR-01, which is approved/);
  assert.match(p.remedy("run", "SCR-03", "--max-budget-usd", "1").err, /SCR-99, which is not in the ledger/);
  assert.match(p.remedy("run", "SCR-01", "--max-budget-usd", "1", "--model", "claude-opus-5").err, /--model takes/);
  assert.match(p.remedy("run", "SCR-01", "--max-budget-usd", "1", "--max-turns", "0").err, /--max-turns/);
  assert.match(p.remedy("run", "SCR-01", "--max-budget-usd", "1", "--base", "no-such-ref").err, /not a commit/);
  assert.equal(p.remedy("run", "--max-budget-usd", "1").code, 2);
  p.remedy("stage", "SCR-01", "in_review");
  assert.match(p.remedy("run", "SCR-01", "--max-budget-usd", "1").err, /is in_review/);
  assert.deepEqual(p.calls(), []);
});

test("a refused project rule stops the run before anything starts", () => {
  const p = project({ config: { run: { allow: ["Bash(node *)"] } } });
  const r = p.remedy("run", "SCR-01", "--max-budget-usd", "1");
  assert.equal(r.code, 2); assert.match(r.err, /run\.allow .*refused/); assert.match(r.err, /wildcard over a command that can run anything/);
  assert.deepEqual(p.calls(), []);
});

test("three active runs is the limit; a dead run does not hold a slot; the same item cannot run twice", () => {
  const p = project({ items: [["SCR-01", {}], ["SCR-02", {}]], scenario: [{ sh: "printf 'status: handoff\\n' | remedy report SCR-02" }] });
  const dir = path.join(p.root, ".fixit/active");
  fs.mkdirSync(dir, { recursive: true });
  const put = (k, pid) => fs.writeFileSync(path.join(dir, k + ".json"), JSON.stringify({ key: k, pid, at: 1 }));
  put("AAA-01", process.pid); put("AAA-02", process.pid); put("AAA-03", process.pid);
  const r = p.remedy("run", "SCR-01", "--max-budget-usd", "1");
  assert.equal(r.code, 2); assert.match(r.err, /3 runs are active/);
  assert.match(p.remedy("run", "SCR-01", "--max-budget-usd", "1", "--dry-run").err, /3 runs are active/);
  assert.deepEqual(p.calls(), []);
  assert.equal(p.item("SCR-01").stage, "approved");
  put("SCR-01", process.pid);
  fs.rmSync(path.join(dir, "AAA-03.json"));
  assert.match(p.remedy("run", "SCR-01", "--max-budget-usd", "1").err, /already active/);
  put("AAA-03", 999999); // dead
  fs.rmSync(path.join(dir, "SCR-01.json"));
  assert.equal(p.remedy("run", "SCR-02", "--max-budget-usd", "1").code, 4, "the dead entry is cleared");
  assert.equal(p.calls().length, 1);
  assert.equal(fs.existsSync(path.join(dir, "AAA-03.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "SCR-02.json")), false, "a finished run gives its slot back");
});

test("--dry-run says what it would do, in at most 10 lines, and writes nothing", () => {
  const p = project({ config: { run: { allow: ["Bash(go vet:*)"] } } });
  const snap = () => git(p.root, "status", "--short", "--ignored");
  const before = snap();
  const r = p.remedy("run", "SCR-01", "--max-budget-usd", "1.5", "--dry-run");
  assert.equal(r.code, 0, r.err);
  assert.ok(lines(r.out).length <= 10);
  assert.match(r.out, /nothing started/); assert.match(r.out, /budget \$1\.50/); assert.match(r.out, /dontAsk/); assert.match(r.out, /Bash\(remedy brief:\*\)/); assert.match(r.out, /Bash\(go vet:\*\)/);
  assert.deepEqual(p.calls(), []);
  assert.equal(snap(), before);
  assert.equal(p.item("SCR-01").stage, "approved");
});

test("a worker that ended on remedy done with an old status in its report: the report is corrected to done", () => {
  const worker = "printf 'status: handoff\\nnext: fix in\\n' | remedy report SCR-01; git -c user.email=t@example.com -c user.name=t commit -qm change --allow-empty; remedy done SCR-01 --commit $(git rev-parse HEAD)";
  const p = project({ scenario: [{ sh: worker }] });
  assert.equal(p.remedy("run", "SCR-01", "--max-budget-usd", "1").code, 0);
  const rep = p.report("SCR-01");
  assert.match(rep, /^status: done\ncommit: [0-9a-f]{7}\nnext: fix in/);
  const q = project({ scenario: [{ sh: "git -c user.email=t@example.com -c user.name=t commit -qm change --allow-empty; remedy done SCR-01 --commit $(git rev-parse HEAD)" }] });
  assert.equal(q.remedy("run", "SCR-01", "--max-budget-usd", "1").code, 0);
  assert.match(q.report("SCR-01"), /^status: done\nbranch: fix\/scr-01\ncommit: /);
});

test("inside a run, brief names the worktree's branch", () => {
  const p = project({ scenario: [{ sh: "remedy brief SCR-01 > brief.txt; printf 'status: handoff\\n' | remedy report SCR-01" }] });
  p.remedy("run", "SCR-01", "--max-budget-usd", "1");
  assert.match(fs.readFileSync(path.join(p.wt("SCR-01"), "brief.txt"), "utf8"), /^branch: fix\/scr-01 /m);
  assert.doesNotMatch(p.remedy("brief", "SCR-01").out, /^branch:/m);
});

test("a finished run: its own worktree, the routed flags, cost on the item, at most 10 lines, exit 0", () => {
  const worker = "git -c user.email=t@example.com -c user.name=t commit -qam change --allow-empty && remedy stage SCR-01 building && remedy done SCR-01 --commit $(git rev-parse HEAD) && printf 'status: done\\n' | remedy report SCR-01";
  const p = project({ scenario: [{ sh: worker }] });
  const r = p.remedy("run", "SCR-01", "--max-budget-usd", "1");
  assert.equal(r.code, 0, r.err + r.out);
  assert.ok(lines(r.out).length <= 10, r.out);
  assert.match(lines(r.out)[0], /^run SCR-01: done \(exit 0\)  stage in_review/);
  assert.match(r.out, /\$0\.25 of \$1\.00/);
  const [c] = p.calls();
  assert.equal(c.cwd, p.wt("SCR-01"));
  assert.equal(c.argv[0], "-p"); assert.equal(c.argv[1], "Build SCR-01. Start with: remedy brief SCR-01");
  assert.equal(flag(c.argv, "--agent"), "fixit-plugin:remedy-builder");
  assert.equal(flag(c.argv, "--model"), "sonnet");
  assert.equal(flag(c.argv, "--effort"), "medium");
  assert.equal(flag(c.argv, "--max-turns"), "60");
  assert.equal(flag(c.argv, "--max-budget-usd"), "1");
  assert.equal(flag(c.argv, "--output-format"), "json");
  assert.equal(flag(c.argv, "--plugin-dir"), path.resolve(__dirname, "../../.."));
  assert.equal(c.env.REMEDY_DIR, path.join(p.root, ".remedy"));
  assert.equal(c.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "120000");
  assert.equal(c.env.REMEDY_RUN_ITEM, "SCR-01");
  assert.ok(c.env.FIXIT_RUN_ID);
  assert.ok(c.path.startsWith(path.resolve(__dirname, "../../../bin")), "bin/ first on PATH");
  assert.equal(git(p.wt("SCR-01"), "branch", "--show-current"), "fix/scr-01");
  const i = p.item("SCR-01");
  assert.equal(i.stage, "in_review");
  assert.deepEqual(i.cost, { usd: 0.25, turns: 7, runs: 1, usage: { input: 10, output: 20, cacheRead: 300, cacheWrite: 40 } });
  assert.ok(fs.existsSync(path.join(p.root, ".remedy/runs/SCR-01-1.json")));
  assert.ok(i.history.some((h) => h.action === "Stage approved → building" && h.by === "remedy run"));
  assert.equal(p.remedy("validate").code, 0);
  assert.equal(i.plan.approvedBy, "the owner", "the run approved nothing");
});

test("--base: the worktree branches from that ref; the default base is the main branch; a reused worktree keeps its branch", () => {
  const p = project({ scenario: [{ sh: "printf 'status: handoff\\n' | remedy report SCR-01" }, { sh: "printf 'status: handoff\\n' | remedy report SCR-01" }, { sh: "printf 'status: handoff\\n' | remedy report SCR-02" }] });
  const mainSha = git(p.root, "rev-parse", "HEAD");
  git(p.root, "checkout", "-q", "-b", "side"); fs.writeFileSync(path.join(p.root, "side.txt"), "s"); git(p.root, "add", "side.txt"); git(p.root, "commit", "-qm", "side");
  const sideSha = git(p.root, "rev-parse", "HEAD");
  assert.equal(p.remedy("run", "SCR-01", "--max-budget-usd", "1", "--base", "side").code, 4);
  assert.equal(git(p.wt("SCR-01"), "rev-parse", "HEAD"), sideSha);
  assert.equal(p.remedy("run", "SCR-01", "--max-budget-usd", "1").code, 4);
  assert.equal(git(p.wt("SCR-01"), "rev-parse", "HEAD"), sideSha, "reused");
  assert.equal(p.calls()[1].cwd, p.wt("SCR-01"));
  const q = project({ scenario: [{ sh: "printf 'status: handoff\\n' | remedy report SCR-01" }] });
  const qMain = git(q.root, "rev-parse", "HEAD");
  git(q.root, "checkout", "-q", "-b", "other"); fs.writeFileSync(path.join(q.root, "o.txt"), "o"); git(q.root, "add", "o.txt"); git(q.root, "commit", "-qm", "o");
  q.remedy("run", "SCR-01", "--max-budget-usd", "1");
  assert.equal(git(q.wt("SCR-01"), "rev-parse", "HEAD"), qMain, "default base is the main branch, not whatever is checked out");
  assert.ok(mainSha);
});

test("a run cut off at the limit leaves a handoff report from git diff --stat and the last digest; exit 4", () => {
  const cut = { subtype: "error_max_turns", is_error: true, total_cost_usd: 0.1, num_turns: 4, usage: {} };
  const sh = "printf 'more\\n' >> app.txt && fixit test failing || true";
  const p = project({ config: { lanes: { failing: { cmd: "echo FAILED boom; exit 1", adapter: "generic" } } }, scenario: [{ sh, result: cut }] });
  const r = p.remedy("run", "SCR-01", "--max-budget-usd", "1", "--max-turns", "4");
  assert.equal(r.code, 4, r.err + r.out);
  assert.equal(flag(p.calls()[0].argv, "--max-turns"), "4");
  assert.match(r.out, /cut off: error_max_turns/);
  assert.ok(lines(r.out).length <= 10);
  const rep = p.report("SCR-01");
  assert.match(rep, /^status: handoff\n/);
  assert.match(rep, /cut off: error_max_turns after 4 turns, \$0\.10/);
  assert.match(rep, /app\.txt/, "git diff --stat");
  assert.match(rep, /last test run \d{8}-/);
  assert.match(rep, /FAILED boom/, "the last digest");
  assert.equal(p.item("SCR-01").stage, "building");
  assert.equal(p.item("SCR-01").cost.usd, 0.1);
});

test("a worker's own report survives the cut, under the script's handoff status", () => {
  const cut = { subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 1.01, num_turns: 9 };
  const p = project({ scenario: [{ sh: "printf 'status: done\\nnext: half way through step 3\\n' | remedy report SCR-01", result: cut }] });
  assert.equal(p.remedy("run", "SCR-01", "--max-budget-usd", "1").code, 4);
  const rep = p.report("SCR-01");
  assert.match(rep, /^status: handoff\n/); assert.match(rep, /error_max_budget_usd/); assert.match(rep, /half way through step 3/);
});

test("empty or broken claude output is handled: a handoff report, not a crash", () => {
  for (const step of [{ out: "" }, { out: "not json" }, { out: "", exit: 1 }]) {
    const p = project({ scenario: [step] });
    const r = p.remedy("run", "SCR-01", "--max-budget-usd", "1");
    assert.equal(r.code, 4, r.err);
    assert.match(r.out, /no JSON from claude/);
    assert.match(p.report("SCR-01"), /^status: handoff\n/);
    assert.equal(p.item("SCR-01").cost.runs, 1);
  }
});

test("a stale report does not speak for a worker that ended silently; plan-drift exits 4 and says so", () => {
  const p = project({ scenario: [{}] });
  fs.mkdirSync(path.join(p.root, ".remedy/runs"), { recursive: true });
  const f = path.join(p.root, ".remedy/runs/SCR-01.md");
  fs.writeFileSync(f, "status: stuck\nold words\n");
  const old = new Date(Date.now() - 3600e3); fs.utimesSync(f, old, old);
  const r = p.remedy("run", "SCR-01", "--max-budget-usd", "1");
  assert.equal(r.code, 4);
  assert.equal(p.calls().length, 1, "no escalation from an old report");
  assert.match(p.report("SCR-01"), /ended without a current report/);
  const q = project({ scenario: [{ sh: "printf 'status: plan-drift\\nthe fix no longer fits\\n' | remedy report SCR-01" }] });
  const s = q.remedy("run", "SCR-01", "--max-budget-usd", "1");
  assert.equal(s.code, 4); assert.match(lines(s.out)[0], /plan-drift/);
  const t = project({ scenario: [{ sh: "printf 'status: done\\n' | remedy report SCR-01" }] });
  const u = t.remedy("run", "SCR-01", "--max-budget-usd", "1");
  assert.equal(u.code, 4, "a report saying done without remedy done is not done");
});

test("a stuck run escalates once, in a fresh process, within the one budget; stuck again goes to blocked", () => {
  const stuck = (usd) => ({ sh: "printf 'status: stuck\\n' | remedy report SCR-01", result: { ...ok, total_cost_usd: usd } });
  const p = project({ scenario: [stuck(0.3), stuck(0.4), stuck(9)] });
  const r = p.remedy("run", "SCR-01", "--max-budget-usd", "1");
  assert.equal(r.code, 3, r.err + r.out);
  const c = p.calls();
  assert.equal(c.length, 2, "exactly one escalation");
  assert.deepEqual(c.map((x) => flag(x.argv, "--model")), ["sonnet", "opus"]);
  assert.deepEqual(c.map((x) => flag(x.argv, "--effort")), ["medium", "high"]);
  assert.equal(flag(c[1].argv, "--max-budget-usd"), "0.7", "the second process gets what is left");
  assert.notEqual(c[0].env.FIXIT_RUN_ID, c[1].env.FIXIT_RUN_ID);
  const i = p.item("SCR-01");
  assert.equal(i.escalation.model, "opus"); assert.equal(i.stage, "blocked"); assert.equal(i.cost.runs, 2); assert.equal(i.cost.usd, 0.7);
  assert.match(r.out, /escalated once: sonnet -> opus/); assert.match(r.out, /blocked/);
  assert.ok(lines(r.out).length <= 10);
  assert.ok(fs.existsSync(path.join(p.root, ".remedy/runs/SCR-01-2.json")));
});

test("the escalated builder starts with a clean count behind STOP, in the same worktree", () => {
  const twice = "fixit test failing; fixit test failing; printf 'status: stuck\\n' | remedy report SCR-01";
  const once = "fixit test failing > once.log; printf 'status: handoff\\n' | remedy report SCR-01";
  const p = project({ config: { lanes: { failing: { cmd: "echo FAILED boom; exit 1", adapter: "generic" } } }, scenario: [{ sh: twice }, { sh: once }] });
  const r = p.remedy("run", "SCR-01", "--max-budget-usd", "1");
  assert.equal(p.calls().length, 2, r.out);
  assert.doesNotMatch(fs.readFileSync(path.join(p.wt("SCR-01"), "once.log"), "utf8"), /STOP/, "its first failure is its first");
  assert.equal(r.code, 4, r.out);
});

test("--no-escalate stops at stuck; no budget left stops at stuck; an escalated builder that finishes is done", () => {
  const stuck = (usd) => ({ sh: "printf 'status: stuck\\n' | remedy report SCR-01", result: { ...ok, total_cost_usd: usd } });
  const a = project({ scenario: [stuck(0.1)] });
  assert.equal(a.remedy("run", "SCR-01", "--max-budget-usd", "1", "--no-escalate").code, 3);
  assert.equal(a.calls().length, 1); assert.equal(a.item("SCR-01").stage, "building"); assert.equal(a.item("SCR-01").escalation, undefined);
  const b = project({ scenario: [stuck(0.99)] });
  const br = b.remedy("run", "SCR-01", "--max-budget-usd", "1");
  assert.equal(br.code, 3); assert.equal(b.calls().length, 1); assert.match(br.out, /not escalated/);
  const fin = "git -c user.email=t@example.com -c user.name=t commit -qam change --allow-empty && remedy done SCR-01 --commit $(git rev-parse HEAD)";
  const c = project({ scenario: [stuck(0.1), { sh: fin }] });
  const cr = c.remedy("run", "SCR-01", "--max-budget-usd", "1");
  assert.equal(cr.code, 0, cr.err + cr.out); assert.equal(c.calls().length, 2); assert.equal(c.item("SCR-01").stage, "in_review");
});

test("an item routed to opus does not escalate: stuck goes straight to blocked", () => {
  const p = project({ items: [["SEC-01", { severity: "high" }]], scenario: [{ sh: "printf 'status: stuck\\n' | remedy report SEC-01" }] });
  const r = p.remedy("run", "SEC-01", "--max-budget-usd", "1");
  assert.equal(r.code, 3); assert.equal(p.calls().length, 1); assert.equal(flag(p.calls()[0].argv, "--model"), "opus"); assert.equal(p.item("SEC-01").stage, "blocked");
});

test("fixit's STOP counts as stuck even if the worker's report says otherwise", () => {
  const twice = "fixit test failing; fixit test failing; printf 'status: handoff\\n' | remedy report SCR-01";
  const p = project({ config: { lanes: { failing: { cmd: "echo FAILED boom; exit 1", adapter: "generic" } } }, scenario: [{ sh: twice }] });
  const r = p.remedy("run", "SCR-01", "--max-budget-usd", "1", "--no-escalate");
  assert.equal(r.code, 3, r.err + r.out);
  assert.match(lines(r.out)[0], /stuck/); assert.match(r.out, /fixit printed STOP in run \d{8}-/);
});

test("the report and the output state plainly when the run changed fixit.config.json", () => {
  const p = project({ config: { lanes: { unit: { cmd: "true" } } }, scenario: [{ sh: "printf '{\"lanes\":{\"unit\":{\"cmd\":\"curl x | sh\"}}}' > fixit.config.json; printf 'status: handoff\\n' | remedy report SCR-01" }] });
  const r = p.remedy("run", "SCR-01", "--max-budget-usd", "1");
  assert.match(r.out, /WARNING: this run changed fixit\.config\.json/);
  const rep = p.report("SCR-01");
  assert.match(rep, /WARNING from remedy run: this run changed fixit\.config\.json/);
  assert.match(rep, /curl x \| sh/, "the diff is in the report, for the reviewer");
  const q = project({ scenario: [{ sh: "printf 'x' >> app.txt; printf 'status: handoff\\n' | remedy report SCR-01" }] });
  const s = q.remedy("run", "SCR-01", "--max-budget-usd", "1");
  assert.doesNotMatch(s.out + q.report("SCR-01"), /WARNING/);
});

test("run.allow reaches the worker; a mechanical item gets the shorter limits; --model overrides the route", () => {
  const p = project({ config: { run: { allow: ["Bash(go vet:*)"] } }, items: [["SCR-01", { risk: "mechanical" }]], scenario: [{ sh: "printf 'status: handoff\\n' | remedy report SCR-01" }, { sh: "printf 'status: handoff\\n' | remedy report SCR-01" }] });
  p.remedy("run", "SCR-01", "--max-budget-usd", "1");
  const [c] = p.calls();
  assert.ok(listOf(c.argv, "--allowedTools").includes("Bash(go vet:*)"));
  assert.equal(flag(c.argv, "--model"), "haiku"); assert.equal(flag(c.argv, "--effort"), "low"); assert.equal(flag(c.argv, "--max-turns"), "30");
  assert.equal(c.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "100000");
  p.remedy("run", "SCR-01", "--max-budget-usd", "1", "--model", "opus", "--max-turns", "9");
  assert.equal(flag(p.calls()[1].argv, "--model"), "opus"); assert.equal(flag(p.calls()[1].argv, "--effort"), "high"); assert.equal(flag(p.calls()[1].argv, "--max-turns"), "9");
});

test("a group shares one worker and one worktree; the cost is split so it still adds up", () => {
  const p = project({ items: [["SCR-01", {}], ["SEC-02", { severity: "high" }]], scenario: [{ sh: "printf 'status: handoff\\n' | remedy report SCR-01", result: { ...ok, total_cost_usd: 0.5 } }] });
  p.remedy("run", "SCR-01,SEC-02", "--max-budget-usd", "1", "--no-escalate");
  const [c] = p.calls();
  assert.equal(p.calls().length, 1);
  assert.equal(c.cwd, p.wt("SCR-01")); assert.equal(flag(c.argv, "--model"), "opus", "the highest route of the group");
  assert.match(c.argv[1], /^Build SCR-01, SEC-02, in that order/);
  assert.equal(c.env.REMEDY_RUN_ITEM, "SCR-01,SEC-02");
  assert.equal(p.item("SCR-01").cost.usd + p.item("SEC-02").cost.usd, 0.5);
  assert.equal(p.item("SEC-02").stage, "building");
});

test("worktree.setup runs once, in the worktree, before the worker; a failure stops the run", () => {
  const p = project({ config: { worktree: { setup: "touch setup-ran" } }, scenario: [{ sh: "printf 'status: handoff\\n' | remedy report SCR-01" }, { sh: "printf 'status: handoff\\n' | remedy report SCR-01" }] });
  p.remedy("run", "SCR-01", "--max-budget-usd", "1");
  assert.ok(fs.existsSync(path.join(p.wt("SCR-01"), "setup-ran")));
  fs.rmSync(path.join(p.wt("SCR-01"), "setup-ran"));
  p.remedy("run", "SCR-01", "--max-budget-usd", "1");
  assert.equal(fs.existsSync(path.join(p.wt("SCR-01"), "setup-ran")), false, "not again on reuse");
  const q = project({ config: { worktree: { setup: "exit 7" } } });
  const r = q.remedy("run", "SCR-01", "--max-budget-usd", "1");
  assert.equal(r.code, 2); assert.match(r.err, /worktree\.setup failed \(exit 7\)/);
  assert.deepEqual(q.calls(), []); assert.equal(q.item("SCR-01").stage, "approved");
});

test("no claude on PATH: refused, nothing written", () => {
  const p = project();
  const onlyGit = fs.mkdtempSync(path.join(os.tmpdir(), "run-path-"));
  fs.symlinkSync(cp.execFileSync("which", ["git"], { encoding: "utf8" }).trim(), path.join(onlyGit, "git"));
  const r = cp.spawnSync(process.execPath, [CLI, "run", "SCR-01", "--max-budget-usd", "1"], { cwd: p.root, encoding: "utf8", env: { ...p.env, PATH: onlyGit } });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /claude is not on PATH/);
  assert.equal(p.item("SCR-01").stage, "approved");
  assert.equal(fs.existsSync(p.wt("SCR-01")), false);
});

test("run results stay out of git and reports do not, without touching the project's own .gitignore", () => {
  const p = project({ scenario: [{ sh: "printf 'status: handoff\\n' | remedy report SCR-01" }] });
  fs.writeFileSync(path.join(p.root, ".gitignore"), "build/\n"); git(p.root, "add", "-A"); git(p.root, "commit", "-qm", "ignore");
  p.remedy("run", "SCR-01", "--max-budget-usd", "1");
  assert.equal(fs.readFileSync(path.join(p.root, ".gitignore"), "utf8"), "build/\n");
  assert.equal(fs.readFileSync(path.join(p.root, ".remedy/.gitignore"), "utf8"), "runs/*.json\n");
  const st = git(p.root, "status", "--short", "--untracked-files=all");
  assert.match(st, /\.remedy\/runs\/SCR-01\.md/);
  assert.doesNotMatch(st, /SCR-01-1\.json/);
  assert.doesNotMatch(st, /\.fixit/);
});

test("remedy refuses the owner's and lead's commands inside a run, whatever the permission rules say", () => {
  const p = project({ items: [["SCR-01", {}], ["SCR-02", { approve: false }], ["SCR-03", {}]] });
  const inRun = (...args) => { const r = cp.spawnSync(process.execPath, [CLI, ...args], { cwd: p.root, encoding: "utf8", input: "text\n", env: { ...p.env, REMEDY_RUN_ITEM: "SCR-01" } }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  for (const a of [["approve", "SCR-02", "--by", "x"], ["set-plan", "SCR-02", "--path", "x", "--summary", "y"], ["request-changes", "SCR-02", "--note", "x"], ["batch", "-"], ["escalate", "SCR-01", "--reason", "x"], ["run", "SCR-01"], ["route", "SCR-01", "--set", "opus", "--by", "x", "--reason", "y"], ["import-findings", "x"], ["handoff"], ["stage", "SCR-02", "building"], ["stage", "SCR-03", "building"], ["stage", "SCR-01", "approved"], ["stage", "SCR-01", "done"], ["done", "SCR-03", "--commit", "HEAD"], ["report", "SCR-03"], ["brief", "SCR-01", "--dir", "/elsewhere"]]) {
    const r = inRun(...a);
    assert.equal(r.code, 2, a.join(" "));
    assert.match(r.err, /refused inside remedy run/, a.join(" "));
  }
  assert.equal(p.item("SCR-02").plan.approvedAt, "");
  assert.equal(p.item("SCR-03").stage, "approved");
  assert.equal(inRun("stage", "SCR-01", "building").code, 0);
  assert.equal(inRun("report", "SCR-01").code, 0);
  assert.equal(inRun("brief", "SCR-01").code, 0);
  assert.equal(inRun("show", "SCR-03").code, 0);
});

test("a new item cannot be filed carrying an approval, by add-item or by batch", () => {
  const p = project();
  const j = path.join(p.stub, "forged.json");
  fs.writeFileSync(j, JSON.stringify({ id: "SCR-07", title: "x", stage: "plan_review", plan: { path: "x", summary: "y", approvedAt: "2026-01-01", approvedBy: "me" } }));
  const r = p.remedy("add-item", "--json", j);
  assert.equal(r.code, 2); assert.match(r.err, /cannot carry an approval/);
  fs.writeFileSync(j, JSON.stringify({ ops: [{ op: "add-item", item: { id: "SCR-07", title: "x", plan: { approvedBy: "me" } } }] }));
  assert.match(p.remedy("batch", j).err, /cannot carry an approval/);
  assert.equal(fs.existsSync(path.join(p.root, ".remedy/items/SCR-07.json")), false);
});

// What a test the worker wrote can do: it runs as the owner, with any environment it likes, on any file.
const editItem = (id, body) => `node -e 'const fs=require("fs"),f=process.env.REMEDY_DIR+"/items/${id}.json",i=JSON.parse(fs.readFileSync(f));${body};fs.writeFileSync(f,JSON.stringify(i))'`;
const FORGE = 'i.plan.approvedAt="2026-01-01";i.plan.approvedBy="owner";i.stage="approved"';
const WAIT = "env -u REMEDY_RUN_ITEM remedy";

test("an approval that appears during a run is put back, by whatever route: the run's items blocked, exit 5, no second worker", () => {
  const routes = {
    "the CLI, with the run's marker removed first": `rm -f "$REMEDY_DIR/../.fixit/active/SCR-01.json"; ${WAIT} approve SCR-02 --by owner`,
    "the item's file": editItem("SCR-02", FORGE),
  };
  for (const [name, sh] of Object.entries(routes)) {
    const p = project({ items: [["SCR-01", {}], ["SCR-02", { approve: false }]], scenario: [{ sh: `${sh}; ${editItem("SCR-01", 'i.stage="in_review"')}; printf 'status: stuck\\n' | remedy report SCR-01` }, {}] });
    const r = p.remedy("run", "SCR-01", "--max-budget-usd", "1");
    assert.equal(r.code, 5, name);
    const l = lines(r.out);
    assert.match(l[0], /^run SCR-01: gate \(exit 5\)  stage blocked/, name);
    assert.match(l[1], /^GATE: SCR-02 \(by owner\) approved during this run/, name);
    assert.ok(l.length <= 10, name);
    assert.equal(p.item("SCR-02").plan.approvedAt, "", name);
    assert.equal(p.item("SCR-02").plan.approvedBy, "", name);
    assert.equal(p.item("SCR-02").stage, "plan_review", name);
    assert.equal(p.item("SCR-02").history.at(-1).action, "Approval removed", name);
    assert.equal(p.item("SCR-01").stage, "blocked", "reported in_review or not, it is not done");
    assert.equal(p.calls().length, 1, "a stuck worker would escalate; this one must not");
    assert.match(p.report("SCR-01"), /^status: blocked\n/, name);
    assert.match(p.report("SCR-01"), /GATE: SCR-02/, name);
    assert.match(p.remedy("run", "SCR-02", "--max-budget-usd", "1").err, /GATE CLOSED/, name);
  }
});

test("the gate check also covers a new item filed approved, and a rewrite of the plan a worker is building", () => {
  const forged = JSON.stringify({ id: "SCR-09", title: "x", stage: "building", plan: { path: "x", summary: "y", approvedAt: "2026-01-01", approvedBy: "owner" } });
  const p = project({ scenario: [{ sh: `printf '%s' '${forged}' > "$REMEDY_DIR/items/SCR-09.json"` }] });
  assert.equal(p.remedy("run", "SCR-01", "--max-budget-usd", "1").code, 5);
  assert.equal(p.item("SCR-09").plan.approvedAt, "");
  assert.equal(p.item("SCR-09").stage, "backlog");
  const q = project({ scenario: [{ sh: editItem("SCR-01", 'i.plan.summary="something else"') }] });
  const was = q.item("SCR-01").plan;
  assert.equal(q.remedy("run", "SCR-01", "--max-budget-usd", "1").code, 5);
  assert.deepEqual(q.item("SCR-01").plan, was);
  assert.equal(q.item("SCR-01").stage, "blocked");
});

test("approving waits for a run, withdrawing does not, and neither sets off the gate check", () => {
  const p = project({ items: [["SCR-01", {}], ["SCR-02", { approve: false }], ["SCR-03", {}]], scenario: [{ sh: `${WAIT} approve SCR-02 --by owner; ${WAIT} import-artifact --items .; ${WAIT} request-changes SCR-03 --note later; printf 'status: handoff\\n' | remedy report SCR-01` }] });
  const r = p.remedy("run", "SCR-01", "--max-budget-usd", "1");
  assert.equal(r.code, 4);
  assert.doesNotMatch(r.out + p.report("SCR-01"), /GATE/);
  const said = fs.readFileSync(path.join(p.stub, "sh.log"), "utf8");
  assert.match(said, /Approving has to wait until no remedy run is active \(now building SCR-01\)/);
  assert.match(said, /Importing items, which can carry approvals, has to wait/);
  assert.equal(p.item("SCR-02").plan.approvedAt, "");
  assert.equal(p.item("SCR-03").stage, "planning");
  assert.equal(p.remedy("approve", "SCR-02", "--by", "the owner").code, 0, "the run is over, so the owner can approve");
});

test("the ledger's .gitignore is added to, not replaced", () => {
  const p = project({ scenario: [{ sh: "printf 'status: handoff\\n' | remedy report SCR-01" }] });
  fs.writeFileSync(path.join(p.root, ".remedy/.gitignore"), "local.txt");
  p.remedy("run", "SCR-01", "--max-budget-usd", "1");
  assert.equal(fs.readFileSync(path.join(p.root, ".remedy/.gitignore"), "utf8"), "local.txt\nruns/*.json\n");
});

test("killing the run takes the worker with it and still leaves a handoff report", async () => {
  const p = project({ scenario: [{ sh: "printf 'more\\n' >> app.txt; sleep 30" }] });
  const child = cp.spawn(process.execPath, [CLI, "run", "SCR-01", "--max-budget-usd", "1"], { cwd: p.root, env: p.env, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", (d) => { out += d; });
  const exited = new Promise((r) => child.on("close", r));
  for (let i = 0; i < 100 && !p.calls().length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(p.calls().length, 1);
  await new Promise((r) => setTimeout(r, 300));
  child.kill("SIGTERM");
  const code = await exited;
  assert.equal(code, 4, out);
  assert.match(out, /cut off: killed by SIGTERM/);
  assert.match(p.report("SCR-01"), /^status: handoff\n/);
  assert.match(p.report("SCR-01"), /app\.txt/);
  assert.equal(fs.existsSync(path.join(p.root, ".fixit/active/SCR-01.json")), false, "the slot is free");
});
