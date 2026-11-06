/* remedy run: build approved items in a fresh `claude -p` worker, in a worktree of their own, under a budget.
 * Zero dependencies, Node >= 18. Called from remedy.cjs, which passes the ledger helpers in.
 *
 * This is the one place the plugin starts a model with permissions already granted, and print mode cannot prompt.
 * So the worker gets --permission-mode dontAsk and an explicit list: anything not named is refused, not asked about.
 * The gate stays the owner's: this script never approves, and it refuses an unapproved item before starting anything.
 * The list is checked by run.test.cjs. Do not add a wildcard across `remedy`, do not name `approve`, and do not add a
 * rule that opens arbitrary execution (node, bash, sh and the like). Never add a permission-bypass flag here.
 * The list limits what the model calls, not what the code it writes does: a builder has to run its own tests, and a
 * test runs as the owner. closeGates() below covers the gate against that. Nothing here covers anything else it reaches.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");
const route = require("./route.cjs");

const PLUGIN_ROOT = path.resolve(__dirname, "..", "..", "..");
const MAX_ACTIVE = 3;
const WINDOW = 120000, WINDOW_MECHANICAL = 100000; // the guard reads the same value from the environment
const TURNS_MECHANICAL = 30;
const MIN_SECOND_RUN_USD = 0.02; // below this a second process could not do anything useful

// Each subcommand a builder needs, one by one. Not `route` (its --set pins a model), `batch`, `escalate` or `set-plan`.
const REMEDY_ALLOW = ["brief", "stage", "report", "done", "add-item", "add-row", "next-id", "show"];
const FIXIT_ALLOW = ["test", "show", "wait", "logs"];
const GIT_ALLOW = ["status", "diff", "add", "commit", "log", "show", "rev-parse", "rm", "mv", "restore"];
const RUN_ALLOW = [
  ...REMEDY_ALLOW.map((s) => `Bash(remedy ${s}:*)`),
  ...FIXIT_ALLOW.map((s) => `Bash(fixit ${s}:*)`),
  ...GIT_ALLOW.map((s) => `Bash(git ${s}:*)`),
  "Bash(git branch --show-current)",
  "Bash(printf:*)", // the builder's report form: printf '...' | remedy report <ID>
  "Read(./**)", "Edit(./**)", "Write(./**)", "NotebookEdit(./**)", "Glob", "Grep",
];
// Deny rules win over any allow rule, including one in the owner's own settings.
const LEDGER_TOOLS = ["approve", "set-plan", "request-changes", "route", "batch", "escalate", "run"];
const RUN_DENY = [
  ...LEDGER_TOOLS.map((s) => `Bash(remedy ${s}:*)`),
  "Bash(git push:*)",
  // git flags that write or read outside the worktree: `git show --output=F HEAD:x` could write any file.
  ...["--output", "--no-index", "--ext-diff"].map((f) => `Bash(git * ${f}*)`),
  ...["Edit", "Write", "NotebookEdit"].flatMap((t) => [`${t}(./.remedy/**)`, `${t}(./.claude/**)`]),
];
// Files a reviewer must see called out, because they change what later runs can do.
const WATCHED = [/^fixit\.config\.json$/, /^\.claude\//, /^\.remedy\//];

// A project's own commands go in fixit.config.json, as `run.allow`. Refused: anything that is not a Bash rule, anything
// touching remedy or the gate, bare Bash, a leading wildcard, and a wildcard over a shell, an interpreter or git.
const OPENERS = /^(?:sh|bash|zsh|dash|ksh|fish|node|deno|bun|python[\d.]*|ruby|perl|php|lua|env|xargs|eval|exec|source|command|builtin|sudo|su|find|awk|gawk|sed|npx|git|ssh|docker|kubectl)\b/;
function projectRuleProblem(rule) {
  if (typeof rule !== "string") return "is not a string";
  const m = /^Bash\((.*)\)$/s.exec(rule);
  if (!m) return "must be a Bash(...) rule";
  const body = m[1].trim();
  if (!body || /^[:*]/.test(body)) return "has no command name";
  if (/\bremedy\b|\bfixit\b|\bapprove\b|set-plan|request-changes/.test(body)) return "touches the ledger or the gate";
  if (/[;&|`$<>\n]/.test(body)) return "contains a shell operator";
  if (OPENERS.test(body) && body.includes("*")) return "is a wildcard over a command that can run anything";
  return null;
}

const rel = (root, p) => path.relative(root, p) || ".";
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const onPath = (bin) => (process.env.PATH || "").split(path.delimiter).some((d) => { try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); return true; } catch { return false; } });
const money = (n) => `$${Number(n || 0).toFixed(Number(n || 0) < 0.1 ? 4 : 2)}`;
function git(cwd, ...args) { return cp.spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 26 }); }
const gitOut = (cwd, ...args) => { const r = git(cwd, ...args); return r.status === 0 ? r.stdout.trim() : ""; };

// ---------- active runs ----------
const activeDir = (main) => path.join(main, ".fixit", "active");
function activeRuns(main) {
  let names = [];
  try { names = fs.readdirSync(activeDir(main)).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const f of names) {
    const p = path.join(activeDir(main), f);
    let a = null;
    try { a = JSON.parse(fs.readFileSync(p, "utf8")); } catch { /* being written, or torn */ }
    if (a && (alive(a.pid) || (a.childPid && alive(a.childPid)))) out.push({ ...a, file: p });
    else if (a) fs.rmSync(p, { force: true });
  }
  return out;
}
// Claim first, count after, so two runs starting together cannot both take the last slot.
function claimSlot(main, key, die) {
  fs.mkdirSync(activeDir(main), { recursive: true });
  const f = path.join(activeDir(main), key + ".json");
  activeRuns(main); // clears stale entries
  try { fs.writeFileSync(f, JSON.stringify({ key, pid: process.pid, at: Date.now() }), { flag: "wx" }); }
  catch (e) { if (e.code === "EEXIST") die(`A run of ${key} is already active.`); throw e; }
  const all = activeRuns(main).sort((a, b) => a.at - b.at || a.pid - b.pid);
  if (all.findIndex((a) => a.key === key) >= MAX_ACTIVE) {
    fs.rmSync(f, { force: true });
    die(`${MAX_ACTIVE} runs are active (${all.filter((a) => a.key !== key).map((a) => a.key).join(", ")}); wait for one to finish.`);
  }
  return f;
}

// ---------- the gate ----------
// This process sits outside the worker's process tree, so a test the worker wrote cannot talk it out of this check.
// remedy approve and import-artifact refuse during a run, so an approval that appears now is not the owner's. Put back.
// A withdrawn approval stays withdrawn: that direction is the owner's to take at any time, and it opens nothing.
const gateOf = (L) => new Map(L.items().map((i) => [i.id, { plan: i.plan, stage: i.stage }]));
function closeGates(L, before, key, addHistory) {
  const opened = [];
  for (const i of L.items()) {
    const was = before.get(i.id);
    if (!i.plan?.approvedAt || JSON.stringify(i.plan) === JSON.stringify(was?.plan)) continue;
    opened.push(`${i.id} (by ${i.plan.approvedBy || "no one"})`);
    i.plan = was ? was.plan : { ...i.plan, approvedAt: "", approvedBy: "" };
    i.stage = was ? was.stage : "backlog";
    addHistory(i, { action: "Approval removed", stage: i.stage, note: `appeared during the remedy run of ${key}` }, "remedy run");
    L.saveItem(i);
  }
  return opened;
}

// ---------- the worktree ----------
function ensureSelfIgnoring(main) {
  fs.mkdirSync(path.join(main, ".fixit"), { recursive: true });
  const ig = path.join(main, ".fixit", ".gitignore");
  if (!fs.existsSync(ig)) { try { fs.writeFileSync(ig, "*\n", { flag: "wx" }); } catch { /* another process won */ } }
}
function worktreeState(main, key) {
  const wt = path.join(main, ".fixit", "worktrees", key);
  const listed = (gitOut(main, "worktree", "list", "--porcelain") || "").split("\n").includes("worktree " + wt);
  return { wt, branch: "fix/" + key.toLowerCase(), reuse: listed };
}
function ensureWorktree(main, st, baseSha, die) {
  if (st.reuse) return;
  fs.mkdirSync(path.dirname(st.wt), { recursive: true });
  const hasBranch = git(main, "rev-parse", "--verify", "--quiet", "refs/heads/" + st.branch).status === 0;
  const r = hasBranch ? git(main, "worktree", "add", st.wt, st.branch) : git(main, "worktree", "add", st.wt, "-b", st.branch, baseSha);
  if (r.status !== 0) die(`git worktree add failed: ${r.stderr.trim()}`);
}
function runSetup(main, st, config, die) {
  const setup = config?.worktree?.setup;
  const marker = st.wt + ".setup-ok";
  if (!setup || fs.existsSync(marker)) return;
  const log = path.join(activeDir(main), path.basename(st.wt) + "-setup.log");
  const fd = fs.openSync(log, "w", 0o600);
  const r = cp.spawnSync("sh", ["-c", setup], { cwd: st.wt, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  if (r.status !== 0) die(`worktree.setup failed (exit ${r.status}); see ${rel(main, log)}. Nothing was started.`);
  fs.writeFileSync(marker, new Date().toISOString() + "\n");
}

// ---------- one worker process ----------
function buildArgs({ prompt, r, turns, budget, main, planDir, allow }) {
  const allowed = [...RUN_ALLOW, ...allow, `Read(//${main.replace(/^\//, "")}/.fixit/runs/**)`, `Read(//${main.replace(/^\//, "")}/${planDir}/**)`];
  const denied = [...RUN_DENY, ...["Edit", "Write", "NotebookEdit"].map((t) => `${t}(//${main.replace(/^\//, "")}/.remedy/**)`)];
  return ["-p", prompt, "--agent", r.agent,
    ...(r.model === "inherit" ? [] : ["--model", r.model]), ...(r.effort === "inherit" ? [] : ["--effort", r.effort]),
    "--max-turns", String(turns), "--max-budget-usd", String(budget), "--output-format", "json",
    "--permission-mode", "dontAsk", "--plugin-dir", PLUGIN_ROOT,
    "--allowedTools", ...allowed, "--disallowedTools", ...denied];
}
function runEnv({ ids, runId, ledgerDir, window }) {
  return { ...process.env, FIXIT_RUN_ID: runId, REMEDY_RUN_ITEM: ids.join(","), REMEDY_DIR: ledgerDir,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window), PATH: path.join(PLUGIN_ROOT, "bin") + path.delimiter + (process.env.PATH || "") };
}
function spawnWorker(args, cwd, env, outFile, errFile, slot) {
  return new Promise((resolve) => {
    const out = fs.openSync(outFile, "w"), err = fs.openSync(errFile, "w", 0o600);
    const child = cp.spawn("claude", args, { cwd, env, stdio: ["ignore", out, err], detached: true });
    try { const a = JSON.parse(fs.readFileSync(slot, "utf8")); fs.writeFileSync(slot, JSON.stringify({ ...a, childPid: child.pid })); } catch { /* cosmetic */ }
    const kill = () => { try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ } };
    process.once("SIGTERM", kill); process.once("SIGINT", kill);
    const fin = (code, signal) => { process.removeListener("SIGTERM", kill); process.removeListener("SIGINT", kill); try { fs.closeSync(out); fs.closeSync(err); } catch { /* closed */ } resolve({ code, signal }); };
    child.on("error", () => fin(127));
    child.on("close", fin);
  });
}
// Empty or unparseable output is a real outcome: the worker died, or was killed. Never assume JSON came back.
function readResult(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (j && typeof j === "object") return j;
  } catch { /* falls through */ }
  return null;
}
function usageOf(j) {
  const u = j?.usage || {};
  return { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 };
}
function recordCost(L, ids, j, addHistory, status) {
  const usd = Number(j?.total_cost_usd) || 0, turns = Number(j?.num_turns) || 0, u = usageOf(j);
  for (const id of ids) { // a group shares one process; split it evenly so the items still add up to the run
    const i = L.item(id), c = i.cost || {}, was = c.usage || {};
    i.cost = { usd: +((c.usd || 0) + usd / ids.length).toFixed(6), turns: (c.turns || 0) + turns, runs: (c.runs || 0) + 1,
      usage: { input: (was.input || 0) + u.input, output: (was.output || 0) + u.output, cacheRead: (was.cacheRead || 0) + u.cacheRead, cacheWrite: (was.cacheWrite || 0) + u.cacheWrite } };
    addHistory(i, { action: "remedy run", stage: i.stage, note: `${status}: ${money(usd)}, ${turns} turns` }, "remedy run");
    L.saveItem(i);
  }
}

// ---------- what the worker left behind ----------
function fixitRuns(main, wt, since) {
  const dir = path.join(process.env.FIXIT_DIR ? path.resolve(process.env.FIXIT_DIR) : path.join(main, ".fixit"), "runs");
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^\d{8}-/.test(n)).sort().slice(-200); } catch { return []; }
  const out = [];
  for (const n of names) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, n, "meta.json"), "utf8"));
      if (m.root === wt && Date.parse(m.createdAt) >= since) out.push({ ...m, dir: path.join(dir, n) });
    } catch { /* still being written */ }
  }
  return out;
}
function readReport(file, since) {
  let st;
  try { st = fs.statSync(file); } catch { return { exists: false, current: false, status: "", text: "" }; }
  const text = fs.readFileSync(file, "utf8");
  const m = /^\s*status:\s*([a-z-]+)/im.exec(text);
  return { exists: true, current: st.mtimeMs >= since, status: m ? m[1].toLowerCase() : "", text };
}
function changedFiles(wt, mergeBase) {
  const a = (gitOut(wt, "diff", "--name-only", mergeBase) || "").split("\n");
  const b = (gitOut(wt, "ls-files", "-o", "--exclude-standard") || "").split("\n");
  return [...new Set([...a, ...b])].filter(Boolean);
}
const clip = (lines, n) => (lines.length > n ? [...lines.slice(0, n), `  +${lines.length - n} lines`] : lines);

// A run cut off at a limit, or a worker that died, still leaves a report a fresh worker can start from.
function writeCutReport(file, { cutWhy, st, head, mergeBase, wt, last, prior, usd, turns }) {
  const stat = (gitOut(wt, "diff", "--stat", mergeBase) || "(no changes against the base)").split("\n");
  const digest = last ? fs.readFileSync(path.join(last.dir, "digest.txt"), "utf8").trimEnd().split("\n") : [];
  const lines = ["status: handoff", `branch: ${st.branch}`, `commit: ${head && head !== mergeBase ? head.slice(0, 7) : "none"}`,
    `cut off: ${cutWhy} after ${turns} turns, ${money(usd)} (written by remedy run)`,
    "next: continue from the diff and the last test run below", "",
    `git diff --stat against ${mergeBase.slice(0, 7)}:`, ...clip(stat, 15).map((l) => "  " + l.trim())];
  if (last) lines.push("", `last test run ${last.id}:`, ...clip(digest, 15).map((l) => "  " + l));
  if (prior) lines.push("", "the worker's last report:", ...clip(prior.trimEnd().split("\n"), 15).map((l) => "  " + l));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

// Done is what the ledger says, not what a report says. Then the STOP line, which does not rely on the worker's memory.
function outcomeOf({ stage, report, cut, lastRun }) {
  if (stage === "in_review" || stage === "done") return "done";
  if (lastRun?.stop) return "stuck";
  if (cut) return "handoff";
  if (report.current && ["stuck", "plan-drift", "handoff"].includes(report.status)) return report.status;
  return "handoff";
}

// ---------- the command ----------
async function main({ pos, opt }, h) {
  const { Ledger, die, stageApply, addHistory, routeOf, ensureRunsIgnored, mainBranchOf, escalateItem } = h;
  const ids = [...new Set((pos[0] || "").split(",").map((x) => x.trim()).filter(Boolean))];
  if (!ids.length) die("Usage: run ID[,ID] --max-budget-usd N [--max-turns N] [--model ALIAS] [--base REF] [--no-escalate] [--dry-run]");
  for (const id of ids) if (!/^[A-Z][A-Z0-9]*-\d{2,}$/.test(id)) die(`Bad id ${id}.`); // it names a directory and a branch
  const L = Ledger.locate(opt).need(), m = L.meta();
  const items = ids.map((id) => L.item(id));

  // 1. Refuse before anything starts. The approval is checked here, not assumed from the stage.
  const refused = [];
  for (const i of items) {
    if (!i.plan?.approvedAt) refused.push(`${i.id}: GATE CLOSED, the plan has no recorded approval. The owner must run: remedy approve ${i.id} --by "<name>"`);
    else if (!["approved", "building"].includes(i.stage)) refused.push(`${i.id} is ${i.stage}; remedy run needs approved or building.`);
    for (const d of i.dependsOn || []) {
      const dep = L.items().find((x) => x.id === d);
      if (!dep || dep.stage !== "done") refused.push(`${i.id} depends on ${d}, which is ${dep ? dep.stage : "not in the ledger"}.`);
    }
  }
  if (refused.length) die(refused.join("\n"));
  const raw = opt["max-budget-usd"] !== undefined ? opt["max-budget-usd"] : m.models?.budgetUsd;
  const budget = Number(raw);
  if (raw === undefined || raw === true || !(budget > 0)) die("remedy run has no default budget: pass --max-budget-usd N, or set models.budgetUsd in .remedy/meta.json.");
  if (opt.model !== undefined && !route.ALIASES.includes(opt.model)) die(`--model takes ${route.ALIASES.join(", ")}.`);
  let turnsFlag = null;
  if (opt["max-turns"] !== undefined) { turnsFlag = Number(opt["max-turns"]); if (!Number.isInteger(turnsFlag) || turnsFlag < 1) die("--max-turns needs a whole number of at least 1."); }

  const main_ = fs.realpathSync(L.root);
  if (!gitOut(main_, "rev-parse", "--git-dir")) die(`remedy run needs a git repository; ${main_} is not one.`);
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(main_, "fixit.config.json"), "utf8")); } catch (e) { if (e.code !== "ENOENT") die(`fixit.config.json is not valid JSON: ${e.message}`); }
  const allow = config.run?.allow === undefined ? [] : config.run.allow;
  if (!Array.isArray(allow)) die("run.allow in fixit.config.json must be a list of Bash(...) rules.");
  const badRules = allow.map((x) => [x, projectRuleProblem(x)]).filter(([, p]) => p);
  if (badRules.length) die(`run.allow in fixit.config.json refused:\n  ${badRules.map(([x, p]) => `${JSON.stringify(x)} ${p}`).join("\n  ")}`);

  const baseRef = opt.base === true ? die("--base needs a ref.") : opt.base;
  const defaultBase = mainBranchOf(L, m);
  const refToSha = (ref) => gitOut(main_, "rev-parse", "--verify", "--quiet", ref + "^{commit}");
  let base = baseRef || defaultBase, baseSha = refToSha(base);
  if (!baseSha && baseRef) die(`--base ${baseRef} is not a commit in this repository.`);
  if (!baseSha) { base = "HEAD"; baseSha = refToSha("HEAD"); }
  if (!baseSha) die("This repository has no commits; a worktree needs one.");

  const key = ids[0];
  let r = route.highest(items.map((i) => routeOf(L, m, i)));
  if (opt.model) r = { ...r, model: opt.model, effort: route.effortFor(m.models, opt.model), reason: `--model ${opt.model}` };
  const mechanical = r.mode === "mechanical";
  const turns = turnsFlag || (mechanical ? TURNS_MECHANICAL : r.turns);
  const window = mechanical ? WINDOW_MECHANICAL : WINDOW;
  const st = worktreeState(main_, key);
  const prompt = ids.length === 1 ? `Build ${key}. Start with: remedy brief ${key}` : `Build ${ids.join(", ")}, in that order. Start with: remedy brief ${key}`;
  const active = activeRuns(main_).filter((a) => a.key !== key);
  const planDir = m.planDir || "docs/remediation";

  if (opt["dry-run"]) {
    if (active.length >= MAX_ACTIVE) die(`${MAX_ACTIVE} runs are active (${active.map((a) => a.key).join(", ")}); wait for one to finish.`);
    const args = buildArgs({ prompt, r, turns, budget, main: main_, planDir, allow });
    const part = (flag) => { const a = args.indexOf(flag), rest = args.slice(a + 1), e = rest.findIndex((x) => x.startsWith("--")); return (e < 0 ? rest : rest.slice(0, e)).join("  "); };
    console.log([`dry run ${ids.join(",")}: nothing started, nothing written.`,
      route.routeLine(r),
      `budget ${money(budget)}  max turns ${turns}  window ${window}  active runs ${active.length} of ${MAX_ACTIVE}`,
      `branch ${st.branch}  base ${base}@${baseSha.slice(0, 7)}  worktree ${rel(main_, st.wt)} (${st.reuse ? "reused, base ignored" : "new"})`,
      `setup: ${config.worktree?.setup || "none"}`,
      `prompt: ${prompt}`,
      `permission mode dontAsk; allowed: ${part("--allowedTools")}`,
      `denied: ${part("--disallowedTools")}`,
      `project rules (fixit.config.json run.allow): ${allow.join("  ") || "none"}`].join("\n"));
    return;
  }
  if (!onPath("claude")) die("claude is not on PATH; nothing was started.");

  // 2. Worktree, setup, stage.
  ensureSelfIgnoring(main_);
  const slot = claimSlot(main_, key, die);
  const release = () => fs.rmSync(slot, { force: true });
  process.once("exit", release);
  const gate = gateOf(L); // after the claim: from here on the owner's approve refuses, so this cannot miss one of theirs
  ensureRunsIgnored(L);
  ensureWorktree(main_, st, baseSha, die);
  runSetup(main_, st, config, die);
  const mergeBase = gitOut(st.wt, "merge-base", "HEAD", baseSha) || baseSha;
  for (const i of items) if (i.stage === "approved") stageApply(L, L.item(i.id), "building", { note: st.branch, by: "remedy run" });

  // 3-5. One process, and at most one more after an escalation. The budget covers both.
  const runsDir = path.join(L.dir, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const reportFile = path.join(runsDir, key + ".md");
  let spent = 0, turnsUsed = 0, status = "handoff", procs = 0, cutWhy = "", stopSeen = null, jsonFile = "", escalated = null, notes = [], opened = [];
  for (;;) {
    let n = 1;
    while (fs.existsSync(path.join(runsDir, `${key}-${n}.json`))) n++;
    jsonFile = path.join(runsDir, `${key}-${n}.json`);
    const started = Date.now(), runId = `${key}-${n}`, leftover = budget - spent;
    const args = buildArgs({ prompt, r, turns, budget: +leftover.toFixed(4), main: main_, planDir, allow });
    const env = runEnv({ ids, runId, ledgerDir: L.dir, window });
    const errFile = path.join(activeDir(main_), runId + ".stderr");
    const done = await spawnWorker(args, st.wt, env, jsonFile, errFile, slot);
    procs++;
    try { if (!fs.statSync(errFile).size) fs.rmSync(errFile); } catch { /* gone */ }
    const j = readResult(jsonFile);
    const usd = Number(j?.total_cost_usd) || 0;
    spent += usd; turnsUsed += Number(j?.num_turns) || 0;
    const cut = !j ? (done.signal ? `killed by ${done.signal}` : `no JSON from claude (exit ${done.code})`) : (j.subtype && j.subtype !== "success") || j.is_error ? (j.subtype || "error") : "";
    if (cut) cutWhy = cut;
    const runs = fixitRuns(main_, st.wt, started), lastRun = runs[runs.length - 1];
    const stopRun = runs.reverse().find((x) => x.stop);
    if (stopRun) stopSeen = stopRun.id;
    const report = readReport(reportFile, started);
    const head = gitOut(st.wt, "rev-parse", "HEAD");
    if (cut && !["in_review", "done"].includes(L.item(key).stage)) {
      writeCutReport(reportFile, { cutWhy: cut, st, head, mergeBase, wt: st.wt, last: lastRun && fs.existsSync(path.join(lastRun.dir, "digest.txt")) ? lastRun : null, prior: report.current ? report.text : "", usd, turns: Number(j?.num_turns) || 0 });
    } else if (!report.current && !["in_review", "done"].includes(L.item(key).stage)) {
      // The worker ended without saying anything current, so a stale report must not speak for it.
      writeCutReport(reportFile, { cutWhy: "the worker ended without a current report", st, head, mergeBase, wt: st.wt, last: lastRun && fs.existsSync(path.join(lastRun.dir, "digest.txt")) ? lastRun : null, prior: "", usd, turns: Number(j?.num_turns) || 0 });
    }
    status = outcomeOf({ stage: L.item(key).stage, report, cut, lastRun });
    recordCost(L, ids, j, addHistory, status);
    opened = closeGates(L, gate, key, addHistory);
    if (opened.length) { // whatever this worker built is now in question, however it reported: no second worker, and not done
      status = "gate";
      for (const id of ids) stageApply(L, L.item(id), "blocked", { note: `an approval appeared during this run: ${opened.join(", ")}`, by: "remedy run" });
      break;
    }
    if (status !== "stuck" || opt["no-escalate"]) break;
    const fresh = L.item(key);
    if (fresh.escalation || r.model === "opus") { // the second builder stopped too: this is the owner's now
      for (const id of ids) stageApply(L, L.item(id), "blocked", { note: "stuck after escalation; the owner decides", by: "remedy run" });
      notes.push("blocked: the escalated builder stopped too; ask the owner.");
      break;
    }
    if (budget - spent < MIN_SECOND_RUN_USD) { notes.push(`not escalated: only ${money(budget - spent)} of the budget left.`); break; }
    const from = r.model;
    escalateItem(L, fresh, undefined, `same failure twice under remedy run${stopSeen ? ` (fixit run ${stopSeen})` : ""}`, "remedy run");
    // The fresh builder gets its own two attempts; it shares this worktree, so the count behind STOP starts again.
    const state = process.env.FIXIT_DIR ? path.resolve(process.env.FIXIT_DIR) : path.join(main_, ".fixit");
    fs.rmSync(path.join(state, "failures", crypto.createHash("sha1").update(st.wt).digest("hex").slice(0, 10) + ".json"), { force: true });
    r = route.highest(ids.map((id) => routeOf(L, m, L.item(id))));
    escalated = `${from} -> ${r.model}`;
  }

  // 6. What a reviewer must see, then at most 10 lines.
  const final = L.item(key);
  // A worker often ends on `remedy done` without another report; the ledger is what counts, so say it in the report too.
  if (status === "done" && fs.existsSync(reportFile)) {
    const had = fs.readFileSync(reportFile, "utf8"), sha = gitOut(st.wt, "rev-parse", "--short", "HEAD");
    const text = /^\s*status:/im.test(had) ? had.replace(/^\s*status:.*$/im, "status: done") : `status: done\n${had}`;
    fs.writeFileSync(reportFile, /^\s*commit:/im.test(text) ? text : text.replace(/^(\s*status:.*)$/im, `$1\ncommit: ${sha}`));
  } else if (status === "done") fs.writeFileSync(reportFile, `status: done\nbranch: ${st.branch}\ncommit: ${gitOut(st.wt, "rev-parse", "--short", "HEAD")}\n`);
  const changed = changedFiles(st.wt, mergeBase).filter((f) => !/^\.fixit\//.test(f));
  const watched = changed.filter((f) => WATCHED.some((re) => re.test(f)));
  if (watched.length) {
    const diff = (gitOut(st.wt, "diff", mergeBase, "--", ...watched) || "").split("\n");
    fs.appendFileSync(reportFile, `\nWARNING from remedy run: this run changed ${watched.join(", ")}. A lane or setting it added runs with the worker's permissions; review it before trusting any green run.\n${clip(diff, 30).join("\n")}\n`);
  }
  const gateLine = `GATE: ${opened.join(", ")} approved during this run, and no worker may approve. Approval removed; ${ids.join(",")} blocked. Review the branch. If the owner did mean it, they approve again.`;
  if (opened.length) {
    const had = fs.existsSync(reportFile) ? fs.readFileSync(reportFile, "utf8").replace(/^\s*status:.*\n?/im, "") : "";
    fs.writeFileSync(reportFile, `status: blocked\n${had.trimEnd()}\n\n${gateLine}\n`);
  }
  const head = gitOut(st.wt, "rev-parse", "HEAD");
  const exit = status === "done" ? 0 : status === "stuck" ? 3 : status === "gate" ? 5 : 4;
  const out = [`run ${ids.join(",")}: ${status} (exit ${exit})  stage ${final.stage}`,
    ...(opened.length ? [gateLine] : []),
    `model ${r.model} effort ${r.effort}  ${procs} process${procs > 1 ? "es" : ""}  ${turnsUsed} turns of ${turns}  ${money(spent)} of ${money(budget)} (total_cost_usd)`,
    `branch ${st.branch}  base ${base}@${baseSha.slice(0, 7)}  head ${head.slice(0, 7)}  ${changed.length} files changed`,
    `report ${rel(main_, reportFile)}  result ${rel(main_, jsonFile)}  worktree ${rel(main_, st.wt)}`];
  if (escalated) out.push(`escalated once: ${escalated}`);
  if (stopSeen) out.push(`fixit printed STOP in run ${stopSeen}`);
  if (cutWhy) out.push(`cut off: ${cutWhy}; report written from git diff --stat and the last digest`);
  if (watched.length) out.push(`WARNING: this run changed ${watched.join(", ")}; review it before trusting any green run.`);
  out.push(...notes);
  console.log(out.slice(0, 10).join("\n"));
  release();
  process.exitCode = exit;
}

module.exports = { main, buildArgs, runEnv, activeRuns, RUN_ALLOW, RUN_DENY, REMEDY_ALLOW, FIXIT_ALLOW, GIT_ALLOW, MAX_ACTIVE, projectRuleProblem, outcomeOf, WINDOW, WINDOW_MECHANICAL, TURNS_MECHANICAL, WATCHED };
