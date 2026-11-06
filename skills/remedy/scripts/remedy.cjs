#!/usr/bin/env node
/* fixit-plugin ledger CLI — zero dependencies, Node >= 18.
 *
 * The ledger lives in <repo>/.remedy/ (override with --dir or REMEDY_DIR):
 *   meta.json            programme metadata: title, waves, clusters, protocol, planDir
 *   items/<ID>.json      tracker items (one file per item: merge-friendly)
 *   register/<KEY>.json  register rows (confirmed defects)
 *
 * The approval gate is enforced here: an item can only reach building,
 * in_review or done after `approve` recorded plan.approvedAt. Editing an
 * approved plan before building withdraws the approval.
 *
 * Run `node remedy.cjs help` for commands.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");
const crypto = require("crypto");
const route = require("./route.cjs");

// ───────────────────────────── constants ─────────────────────────────
const STAGES = ["backlog", "planning", "plan_review", "approved", "building", "in_review", "done", "blocked", "wont_do"];
const PAST_GATE = new Set(["building", "in_review", "done"]);
const SEVERITIES = ["critical", "high", "medium", "low", "unrated"];
const KINDS = ["bug", "todo", "stub", "gap", "debt", "test-gap", "perf", "feature", "validation", "hardening"];
const REG_STATUSES = ["open", "in_progress", "fix_in_review", "fixed", "wont_fix"];
const STAGE_TO_STATUS = {
  backlog: "open", planning: "open", plan_review: "open", approved: "open", blocked: "open",
  building: "in_progress", in_review: "fix_in_review", done: "fixed", wont_do: "wont_fix",
};
const ID_RE = /^[A-Z][A-Z0-9]*-\d{2,}$/;
const DEFAULT_PROTOCOL = [
  "Start a planning run with “plan <ID>” or “plan cluster <NAME>”.",
  "The run moves items to Planning, investigates, asks the owner the decisions that are theirs, and writes <planDir>/<ID>.md.",
  "It records the plan path and summary on each item and moves it to Plan review.",
  "An owner approves each item. Nothing is built before its approval is recorded.",
  "A build session flips the pinned test in the same change, moves the item to In review and Done, and mirrors the status to the register.",
];
const DEFAULT_WAVES = [
  { id: "W0", name: "Stop the bleeding", why: "Exploitable now: account takeover, leaked secrets, cross-tenant access." },
  { id: "W1", name: "Integrity", why: "Wrong, unauthorised or racy decisions and data." },
  { id: "W2", name: "Scale and access", why: "Unbounded scans and unscoped reads that block rollout." },
  { id: "W3", name: "User-facing defects", why: "Broken or misleading flows." },
  { id: "W4", name: "Platform and hygiene", why: "Deploy, CI, tooling, tests, debt." },
  { id: "W5", name: "Feature gaps", why: "Stubs, placeholders and missing integrations." },
];

// ───────────────────────────── args / io ─────────────────────────────
function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) opt[a.slice(2, eq)] = a.slice(eq + 1);
      else if (a === "--open" && i + 1 < argv.length) opt.open = [...(opt.open || []), argv[++i]]; // the one flag that repeats
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) opt[a.slice(2)] = argv[++i];
      else opt[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}
class UserError extends Error {}
const die = (m) => { throw new UserError(m); };
const now = () => new Date().toISOString();
const readJSON = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
function writeText(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, s);
  fs.renameSync(tmp, p);
}
const writeJSON = (p, v) => writeText(p, JSON.stringify(v, null, 2) + "\n");
function gitRoot(cwd) {
  try { return cp.execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return cwd; }
}

// ───────────────────────────── ledger ─────────────────────────────
// The main checkout's root when cwd is in a linked worktree, else the plain git root.
function mainRoot(cwd) {
  try {
    const common = cp.execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const abs = path.resolve(cwd, common);
    if (path.basename(abs) === ".git") return path.dirname(abs);
  } catch { /* not a git repo */ }
  return gitRoot(cwd);
}
const sleepMs = (n) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);
// A short lock around one file write. It does not span a read-modify-write, so parallel chains can still lose each other's meta.json edits.
function withLock(file, fn) {
  const lock = file + ".lock", t0 = Date.now();
  let fd;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (;;) {
    try { fd = fs.openSync(lock, "wx"); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.rmSync(lock, { force: true }); } catch { /* raced */ }
      if (Date.now() - t0 > 5000) die(`${path.basename(file)} is locked by another remedy process (${path.basename(lock)}); remove it if that process is gone.`);
      sleepMs(25);
    }
  }
  try { return fn(); } finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
}

class Ledger {
  constructor(dir) {
    this.dir = dir;
    this.root = path.dirname(dir);
    this.buf = null; // write buffer: path -> JSON text, while a batch is open
    this.base = {};  // disk snapshot per subdirectory, taken once while buffering
  }
  // --dir and REMEDY_DIR win. Otherwise the main checkout's ledger, so a worktree reads and writes the lead's copy;
  // a worktree with its own .remedy and no main one falls back to its own.
  static locate(opt) {
    if (Ledger.active) return Ledger.active;
    if (opt.dir) return new Ledger(path.resolve(opt.dir));
    if (process.env.REMEDY_DIR) return new Ledger(path.resolve(process.env.REMEDY_DIR));
    const cwd = process.cwd(), main = path.join(mainRoot(cwd), ".remedy");
    return new Ledger(fs.existsSync(path.join(main, "meta.json")) ? main : path.join(gitRoot(cwd), ".remedy"));
  }
  // Buffered mode: reads see buffered writes, commit() flushes them, discard() drops them.
  begin() { this.buf = new Map(); this.base = {}; return this; }
  commit() {
    const buf = this.buf; this.buf = null; this.base = {};
    for (const [p, text] of buf) { const v = JSON.parse(text); if (p === path.join(this.dir, "meta.json")) this.saveMeta(v, true); else writeJSON(p, v); }
    return buf.size;
  }
  discard() { this.buf = null; this.base = {}; }
  _has(p) { return !!(this.buf && this.buf.has(p)) || fs.existsSync(p); }
  _read(p) { return this.buf && this.buf.has(p) ? JSON.parse(this.buf.get(p)) : readJSON(p); }
  _write(p, v) { if (this.buf) this.buf.set(p, JSON.stringify(v)); else writeJSON(p, v); }
  exists() { return fs.existsSync(path.join(this.dir, "meta.json")); }
  need() { if (!this.exists()) die(`No ledger at ${this.dir}. Run: remedy init --title "<programme>"`); return this; }
  meta() { return this._read(path.join(this.dir, "meta.json")); }
  saveMeta(m, flush) {
    m.updatedAt = now();
    const p = path.join(this.dir, "meta.json");
    if (this.buf && !flush) this.buf.set(p, JSON.stringify(m));
    else withLock(p, () => writeJSON(p, m));
  }
  // Callers of items()/rows() must not mutate what they get back; use item(id)/row(k) to edit.
  _list(sub) {
    const d = path.join(this.dir, sub);
    if (!this.buf) return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => readJSON(path.join(d, f))) : [];
    if (!this.base[sub]) this.base[sub] = new Map(fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => [path.join(d, f), readJSON(path.join(d, f))]) : []);
    const all = new Map(this.base[sub]);
    for (const [p, text] of this.buf) if (path.dirname(p) === d) all.set(p, JSON.parse(text));
    return [...all.values()];
  }
  items() { return this._list("items").sort((a, b) => (a.order ?? 0) - (b.order ?? 0)); }
  rows() { return this._list("register").sort((a, b) => (a.order ?? 0) - (b.order ?? 0)); }
  itemPath(id) { return path.join(this.dir, "items", id + ".json"); }
  rowPath(k) { return path.join(this.dir, "register", k + ".json"); }
  item(id) { const p = this.itemPath(id); if (!this._has(p)) die(`No item ${id}.`); return this._read(p); }
  row(k) { const p = this.rowPath(k); return this._has(p) ? this._read(p) : null; }
  saveItem(i) { this._write(this.itemPath(i.id), i); }
  saveRow(r) { this._write(this.rowPath(r.key), r); }
  createItem(i) { if (this._has(this.itemPath(i.id))) die(`Item ${i.id} already exists (create-only; pick another id with next-id).`); this.saveItem(i); }
  createRow(r) { if (this._has(this.rowPath(r.key))) die(`Register row ${r.key} already exists.`); this.saveRow(r); }
  nextOrder(kind) {
    const list = kind === "row" ? this.rows() : this.items();
    return list.reduce((m, x) => Math.max(m, x.order ?? 0), 0) + 1;
  }
  takenIds() { return new Set([...this.items().map((i) => i.id), ...this.rows().map((r) => r.key)]); }
  nextId(prefix, count = 1) {
    const taken = this.takenIds();
    const reserved = (this.meta().reservedIds || []).filter((r) => r.prefix === prefix);
    let n = 0;
    for (const id of taken) { const m = id.match(new RegExp("^" + prefix + "-(\\d+)$")); if (m) n = Math.max(n, +m[1]); }
    for (const r of reserved) n = Math.max(n, r.to);
    const out = [];
    while (out.length < count) { n++; const id = `${prefix}-${String(n).padStart(2, "0")}`; if (!taken.has(id)) out.push(id); }
    return out;
  }
}

function blankItem(o) {
  return {
    id: o.id, title: o.title || "", summary: o.summary || "", impact: o.impact || "",
    severity: o.severity || "unrated", kind: o.kind || "bug", wave: o.wave || "", workstream: o.workstream || "",
    component: o.component || "", cluster: o.cluster || "", stage: o.stage || "backlog",
    dependsOn: o.dependsOn || [], sources: o.sources || [], pinnedBy: o.pinnedBy || "",
    acceptance: o.acceptance || "Defined in the item's plan; a test fails before the fix and passes after.",
    registerKey: o.registerKey || "", fingerprint: o.fingerprint || "",
    plan: { path: "", summary: "", approvedAt: "", approvedBy: "", ...(o.plan || {}) },
    note: o.note || "", order: o.order, history: o.history || [], updatedAt: o.updatedAt || now(), updatedBy: o.updatedBy || "",
    ...(o.risk ? { risk: o.risk } : {}), ...(o.model ? { model: o.model } : {}), ...(o.escalation ? { escalation: o.escalation } : {}), ...(o.cost ? { cost: o.cost } : {}),
  };
}
function blankRow(o) {
  return {
    key: o.key, title: o.title || "", detail: o.detail || "", impact: o.impact || "", location: o.location || "",
    category: o.category || "", component: o.component || "", severity: o.severity || "unrated", status: o.status || "open",
    foundBy: o.foundBy || "", confidence: o.confidence || "", pinnedBy: o.pinnedBy || "", fingerprint: o.fingerprint || "",
    note: o.note || "", order: o.order, history: o.history || [], updatedAt: o.updatedAt || now(), updatedBy: o.updatedBy || "",
  };
}
function addHistory(x, entry, by) { x.history = [...(x.history || []), { ...entry, by: by || "", at: now() }].slice(-40); x.updatedAt = now(); x.updatedBy = by || ""; }

// ───────────────────────────── validation ─────────────────────────────
function validate(L) {
  const errors = [], warnings = [];
  const m = L.meta();
  const items = L.items(), rows = L.rows();
  const ids = new Set(items.map((i) => i.id));
  const keys = new Set(rows.map((r) => r.key));
  const waves = new Set((m.waves || []).map((w) => w.id));
  const clusters = new Map((m.clusters || []).map((c) => [c.id, c]));
  const planDir = m.planDir || "docs/remediation";
  for (const i of items) {
    const e = (s) => errors.push(`${i.id}: ${s}`), w = (s) => warnings.push(`${i.id}: ${s}`);
    if (!ID_RE.test(i.id)) e(`id must look like PREFIX-NN`);
    if (!i.title) e("title is empty");
    if (!STAGES.includes(i.stage)) e(`unknown stage ${i.stage}`);
    if (!SEVERITIES.includes(i.severity)) e(`unknown severity ${i.severity}`);
    if (!KINDS.includes(i.kind)) w(`unusual kind ${i.kind}`);
    if (i.wave && waves.size && !waves.has(i.wave)) w(`wave ${i.wave} is not in meta.waves`);
    if (PAST_GATE.has(i.stage) && !i.plan?.approvedAt) e(`stage ${i.stage} without a recorded plan approval (gate)`);
    if (i.stage === "approved" && !i.plan?.approvedAt) e("stage approved but plan.approvedAt is empty");
    if (["plan_review", "approved", ...PAST_GATE].includes(i.stage)) {
      if (!i.plan?.path) e(`stage ${i.stage} needs plan.path`);
      else if (!fs.existsSync(path.join(L.root, i.plan.path))) w(`plan file ${i.plan.path} not found`);
      if (!i.plan?.summary) w("plan.summary is empty");
    }
    for (const d of i.dependsOn || []) if (!ids.has(d)) w(`dependsOn ${d} is not a tracker item`);
    if (i.registerKey && !keys.has(i.registerKey)) e(`registerKey ${i.registerKey} has no register row`);
    if (i.cluster) {
      const c = clusters.get(i.cluster);
      if (!c) e(`cluster ${i.cluster} is not in meta.clusters`);
      else if (!c.items.includes(i.id)) e(`cluster ${i.cluster} does not list ${i.id}`);
    }
    if (i.stage === "done" && !i.pinnedBy && i.kind === "bug") w("done bug with no pinnedBy test");
    if (i.plan?.path && !i.plan.path.startsWith(planDir)) w(`plan path is outside planDir (${planDir})`);
    for (const x of route.checkItemRouting(i)) e(x);
  }
  for (const x of route.checkModels(m.models)) errors.push(x);
  if (m.mainBranch !== undefined && (typeof m.mainBranch !== "string" || !m.mainBranch)) errors.push("meta.mainBranch must be a non-empty string");
  for (const c of m.clusters || []) for (const id of c.items) {
    if (!ids.has(id)) errors.push(`cluster ${c.id}: lists unknown item ${id}`);
    else if (items.find((i) => i.id === id).cluster !== c.id) errors.push(`cluster ${c.id}: ${id}.cluster is not ${c.id}`);
  }
  for (const r of rows) {
    if (!REG_STATUSES.includes(r.status)) errors.push(`${r.key}: unknown register status ${r.status}`);
    if (!SEVERITIES.includes(r.severity)) errors.push(`${r.key}: unknown severity ${r.severity}`);
    const linked = items.find((i) => i.registerKey === r.key);
    if (!linked) warnings.push(`${r.key}: register row has no tracker item`);
    else if (STAGE_TO_STATUS[linked.stage] !== r.status && !(linked.stage === "blocked")) warnings.push(`${r.key}: status ${r.status} out of step with ${linked.id} stage ${linked.stage} (run sync-register)`);
  }
  const fps = new Map();
  for (const i of items) if (i.fingerprint) {
    if (fps.has(i.fingerprint)) errors.push(`${i.id}: fingerprint ${i.fingerprint} is already used by ${fps.get(i.fingerprint)}`);
    fps.set(i.fingerprint, i.id);
  }
  return { errors, warnings };
}

// ───────────────────────────── commands ─────────────────────────────
const cmds = {};

cmds.help = () => {
  console.log(`remedy — gated remediation ledger

  init --title T [--project P] [--plan-dir docs/remediation] [--no-waves]
  init --settings [--apply] [--model ALIAS] [--revert]   show the project settings a token-efficient run needs; writes only with --apply
  status [--ids] [--clusters] [--cluster ID] [--render] [--json]
                                     at most 20 lines: stage counts, open critical, clusters with active work
  brief ID [--role builder|planner] [--json]   what a worker needs, at most 40 lines; exit 2 (GATE CLOSED) if the plan is not approved
  route ID | route --role R | route --cluster C | route ID --set ALIAS --by WHO --reason R
                                     one line: agent, model, effort, turns, reason; --set pins item.model
  escalate ID --reason R [--model ALIAS] [--by WHO]   pin the escalation model after the same failure twice
  batch FILE|- [--dry-run] [--no-validate]   many ops in one call, all or nothing (never approve); see the ops below
  next-id PREFIX [--count N]          next free ids (items, register rows and reserved ranges)
  reserve PREFIX --from N --to M --owner S   reserve an id range for a parallel session
  add-item --json FILE|-              create-only; fields as in schemas/item.schema.json
  add-row  --json FILE|-              create-only register row; fields as in schemas/register.schema.json
  show ID [--history]                 print an item (and its register row), without history unless asked
  cluster ID --name NAME [--items A,B] [--add A] [--remove A]
  set-plan ID --path P --summary S [--risk R] [--pinned-by T] [--depends-on A,B] [--by WHO]   record the plan; moves to plan_review; withdraws a prior approval
  stage A[,B,C] STAGE [--note N] [--by WHO]     move along the lifecycle (gate checked for all first; use approve for 'approved')
  approve ID --by WHO [--note N]                OWNER ONLY: record plan approval
  request-changes ID --note N [--by WHO]        send a plan back to planning
  note ID TEXT                         set the item note
  done ID[,ID] --commit SHA [--by WHO]   done if SHA is on the main branch, else in_review; mirrors, validates, renders
  report ID [--show]                   stdin to <ledger>/runs/ID.md; --show prints it (at most 40 lines)
  run ID[,ID] --max-budget-usd N [--max-turns N] [--model ALIAS] [--base REF] [--no-escalate] [--dry-run]
                                     build approved items in a fresh worker and its own worktree; never approves; no default budget; at most 3 at once. Exit 0 done, 3 stuck, 4 handoff, 2 refused
  handoff [--next T] [--open T]... [--from FILE|-]   write <ledger>/handoff/<time>.md for a fresh session
  handoff --latest                     print the newest handoff (at most 60 lines)
  sync [--dry-run] [--artifact-prepare --out DIR] [--artifact-commit]   register mirror + validate + render in one call
  publish --prepare --out DIR          changed-only ArtifactData batches (seeds everything on first use)
  sync-register [--dry-run]            mirror tracker stages onto linked register rows
  import-findings FILE [--prefix SEC] [--wave W0] [--found-by TEXT] [--workstream TEXT] [--dry-run]
                                       intake a security-audit findings.json (confirmed → register + item; needs_validation → item)
  import-campaign FILE [--prefix P] [--wave W] [--found-by TEXT] [--dry-run]
                                       intake a test-campaign campaign-findings.json (confirmed → register + item; lead → item)
  scan [--root DIR]                  list pinned-defect markers (it.fails, .todo, test.fixme, KNOWN_ ratchets, BUG:) as JSON
  usage [--since D] [--until D] [--project P] [--exclude P,Q] [--by session|agent|item|kind|model] [--waste] [--price opus=1,sonnet=R,haiku=R] [--json]
                                     where tokens went, from ~/.claude/projects transcripts (no ledger needed); at most 40 lines
  validate [--all]                     schema + gate + cross-reference + routing checks, repeats grouped (exit 1 on errors)
  render [--out FILE]                  self-contained read-only dashboard (tracker + register)
  export-artifact --out DIR            payload files for a claude.ai artifact backend (items/, bugs/, meta-protocol.json)
  import-artifact [--items DIR] [--bugs DIR] [--meta FILE]   refresh the ledger from ArtifactData out_dir snapshots

batch file: { "by": "WHO", "ops": [ {op:"stage", id|ids, stage, note}, {op:"note", id, text},
  {op:"set-plan", id, path, summary, risk, pinnedBy, dependsOn}, {op:"cluster", id, name, items|add|remove}, {op:"request-changes", id, note},
  {op:"add-item", item}, {op:"add-row", row} ] }   (each op may carry its own "by")

Global: --dir PATH (default: the main checkout's .remedy, also from a worktree; or REMEDY_DIR)`);
};

// Plugins cannot set these, so they go in the project's .claude/settings.json.
// --apply records what it added beside the ledger, so --revert can undo exactly that.
const SETTINGS_MODELS = ["opus", "sonnet", "haiku"];
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const settingAt = (o, key) => key.split(".").reduce((v, k) => (v && typeof v === "object" ? v[k] : undefined), o);
function readSettings(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (text === null) return { text, value: {} };
  let value;
  try { value = JSON.parse(text); } catch (e) { die(`${file} is not valid JSON, so nothing was changed: ${e.message}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) die(`${file} does not hold a JSON object, so nothing was changed.`);
  if (value.env !== undefined && (!value.env || typeof value.env !== "object")) die(`${file} has an env that is not an object, so nothing was changed.`);
  return { text, value };
}
function formatSettings(value, text) {
  const indent = text?.match(/^\{\r?\n([ \t]+)"/)?.[1] ?? 2;
  return JSON.stringify(value, null, indent) + (text === null || text.endsWith("\n") ? "\n" : "");
}
function firstTurnSize(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 4 * 1024 * 1024));
    fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString("utf8").split("\n")) {
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const u = o?.type === "assistant" && o.message?.usage;
      if (u) return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    }
    return null;
  } finally { fs.closeSync(fd); }
}
function freshContextLine(root) {
  const dir = path.join(os.homedir(), ".claude", "projects", root.replace(/[^A-Za-z0-9]/g, "-"));
  const median = (files, limit) => {
    const recent = files.map((f) => [fs.statSync(f).mtimeMs, f]).sort((a, b) => b[0] - a[0]).slice(0, limit);
    const sizes = recent.map(([, f]) => firstTurnSize(f)).filter((n) => n !== null).sort((a, b) => a - b);
    return sizes.length ? `${Math.round(sizes[sizes.length >> 1] / 1000)}k over ${sizes.length}` : "none";
  };
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const main = entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => path.join(dir, e.name));
    const subs = entries.filter((e) => e.isDirectory()).flatMap((e) => {
      const d = path.join(dir, e.name, "subagents");
      return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(d, f)) : [];
    });
    return `Fresh context, median first turn of recent sessions: main ${median(main, 10)}, subagent ${median(subs, 20)}.`;
  } catch { return "Fresh context: no recent sessions found for this project."; }
}
function revertSettings(L, file, stateFile) {
  if (!fs.existsSync(stateFile)) die(`Nothing to revert: ${path.relative(process.cwd(), stateFile)} does not exist.`);
  const state = readJSON(stateFile);
  const shown = path.relative(L.root, file);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (text !== null && sha256(text) === state.afterHash) {
    if (state.before === null) fs.rmSync(file);
    else writeText(file, state.before);
    console.log(`Restored ${shown} to its state before --apply.`);
  } else if (text !== null) {
    const { value } = readSettings(file);
    const left = [];
    for (const { key, value: added } of state.added) {
      if (settingAt(value, key) === undefined) continue;
      if (settingAt(value, key) !== added) { left.push(key); continue; }
      const dot = key.indexOf(".");
      if (dot < 0) delete value[key];
      else delete value[key.slice(0, dot)][key.slice(dot + 1)];
    }
    if (state.createdEnv && value.env && !Object.keys(value.env).length) delete value.env;
    writeText(file, formatSettings(value, text));
    console.log(`${shown} changed after --apply, so only the added keys were removed.${left.length ? ` Left alone because their values changed: ${left.join(", ")}.` : ""}`);
  } else console.log(`${shown} no longer exists; nothing to remove.`);
  fs.rmSync(stateFile);
}
function initSettings(opt) {
  const L = Ledger.locate(opt);
  const file = path.join(L.root, ".claude", "settings.json");
  const stateFile = path.join(L.dir, "settings-applied.json");
  if (opt.revert) return revertSettings(L, file, stateFile);
  if (opt.model !== undefined && !SETTINGS_MODELS.includes(opt.model)) die(`--model takes ${SETTINGS_MODELS.join(", ")}.`);
  const { text, value } = readSettings(file);
  const proposal = [["autoCompactWindow", 150000], ["env.BASH_MAX_OUTPUT_LENGTH", "10000"], ...(opt.model ? [["model", opt.model]] : [])];
  const adds = proposal.filter(([key]) => settingAt(value, key) === undefined);
  const shown = path.relative(L.root, file);
  console.log(`${shown}${text === null ? " (new file)" : ""}:`);
  for (const [key, v] of proposal) {
    const cur = settingAt(value, key);
    if (cur === undefined) console.log(`+ ${key}: ${JSON.stringify(v)}`);
    else if (cur === v) console.log(`  ${key}: ${JSON.stringify(v)} (already set)`);
    else console.log(`  ${key}: keeping ${JSON.stringify(cur)} (proposed ${JSON.stringify(v)})`);
  }
  if (!adds.length) console.log("Nothing to add.");
  else if (!opt.apply) console.log(`Nothing written. To apply: remedy init --settings --apply${opt.model ? ` --model ${opt.model}` : ""}`);
  else {
    const next = JSON.parse(JSON.stringify(value));
    const createdEnv = adds.some(([key]) => key.startsWith("env.")) && !next.env;
    for (const [key, v] of adds) {
      if (key.startsWith("env.")) (next.env ??= {})[key.slice(4)] = v;
      else next[key] = v;
    }
    const after = formatSettings(next, text);
    const prior = fs.existsSync(stateFile) ? readJSON(stateFile) : null;
    writeJSON(stateFile, {
      before: prior ? prior.before : text,
      added: [...(prior?.added || []), ...adds.map(([key, v]) => ({ key, value: v }))],
      createdEnv: !!prior?.createdEnv || createdEnv,
      afterHash: sha256(after),
    });
    writeText(file, after);
    console.log(`Wrote ${shown}. Undo with: remedy init --settings --revert`);
  }
  console.log(freshContextLine(L.root));
  console.log("Run /context in a session for the breakdown, and disable plugins and MCP servers this project does not use.");
}

cmds.init = ({ opt }) => {
  if (opt.settings) return initSettings(opt);
  const L = Ledger.locate(opt);
  if (L.exists()) die(`A ledger already exists at ${L.dir}.`);
  const m = {
    title: opt.title || "Remediation Tracker",
    project: opt.project || path.basename(L.root),
    subtitle: opt.subtitle || "",
    planDir: opt["plan-dir"] || "docs/remediation",
    createdAt: now(),
    waves: opt["no-waves"] ? [] : DEFAULT_WAVES,
    clusters: [],
    protocol: DEFAULT_PROTOCOL,
    excluded: opt.excluded || "",
    reservedIds: [],
    decisions: [],
    publish: { trackerUrl: "", registerUrl: "" },
  };
  fs.mkdirSync(path.join(L.dir, "items"), { recursive: true });
  fs.mkdirSync(path.join(L.dir, "register"), { recursive: true });
  L.saveMeta(m);
  ensureRunsIgnored(L);
  fs.writeFileSync(path.join(L.dir, "README.md"), `# ${m.title}\n\nThis directory is a fixit-plugin ledger. Edit it with the remedy CLI or the /fixit-plugin commands, not by hand.\nPlans live in \`${m.planDir}/\`. Run \`node <plugin>/skills/remedy/scripts/remedy.cjs status\`.\n`);
  fs.mkdirSync(path.join(L.root, m.planDir), { recursive: true });
  console.log(`Initialised ${path.relative(process.cwd(), L.dir) || L.dir} (plans in ${m.planDir}/).`);
};

const trunc = (s, n = 200) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const ACTIVE = ["approved", "building", "in_review"];
cmds.status = ({ opt }) => {
  const L = Ledger.locate(opt).need();
  const m = L.meta(), items = L.items(), rows = L.rows();
  const byId = new Map(items.map((i) => [i.id, i]));
  const by = Object.fromEntries(STAGES.map((s) => [s, items.filter((i) => i.stage === s)]));
  const s = {
    title: m.title, items: items.length, registerRows: rows.length,
    byStage: Object.fromEntries(STAGES.map((k) => [k, by[k].length])),
    waitingForApproval: by.plan_review.map((i) => i.id),
    approvedNotBuilt: by.approved.map((i) => i.id),
    building: by.building.map((i) => i.id),
    openCritical: items.filter((i) => i.severity === "critical" && !["done", "wont_do"].includes(i.stage)).map((i) => i.id),
    clusters: (m.clusters || []).map((c) => ({ id: c.id, name: c.name, items: c.items.length, planned: c.items.filter((id) => byId.get(id)?.plan?.path).length, approved: c.items.filter((id) => byId.get(id)?.plan?.approvedAt).length, done: c.items.filter((id) => byId.get(id)?.stage === "done").length })),
    unclusteredBacklog: items.filter((i) => !i.cluster && i.stage === "backlog").map((i) => i.id),
    registerOpen: rows.filter((r) => ["open", "in_progress"].includes(r.status)).length,
  };
  if (opt.render) renderDashboard(L, {});
  if (opt.json) return console.log(JSON.stringify(s, null, 2));
  const out = [];
  if (opt.cluster) {
    const c = (m.clusters || []).find((x) => x.id === opt.cluster) || die(`No cluster ${opt.cluster}.`);
    out.push(`${c.id} ${c.name}: ${c.items.length} items`);
    for (const id of c.items) { const i = byId.get(id); out.push(i ? `${id.padEnd(8)} ${i.stage.padEnd(11)} ${i.severity.padEnd(8)} ${i.title}` : `${id} (not in ledger)`); }
    return console.log(out.map((l) => trunc(l)).join("\n"));
  }
  out.push(`${s.title} — ${s.items} items, ${s.registerRows} register rows (${s.registerOpen} unresolved)`);
  out.push(STAGES.map((k) => `${k}:${s.byStage[k]}`).join("  "));
  const ids = (a, n) => a.slice(0, n).join(", ") + (a.length > n ? ` +${a.length - n}` : "");
  out.push(`open critical: ${s.openCritical.length}${s.openCritical.length ? ` (${ids(s.openCritical, 5)})` : ""}   awaiting approval: ${s.waitingForApproval.length}   approved, not built: ${s.approvedNotBuilt.length}   building: ${s.building.length}`);
  if (opt.ids) {
    if (s.waitingForApproval.length) out.push(`Waiting for owner approval: ${s.waitingForApproval.join(", ")}`);
    if (s.approvedNotBuilt.length) out.push(`Approved, not yet built: ${s.approvedNotBuilt.join(", ")}`);
    if (s.building.length) out.push(`Building: ${s.building.join(", ")}`);
    if (s.openCritical.length) out.push(`Open critical: ${s.openCritical.join(", ")}`);
    if (s.unclusteredBacklog.length) out.push(`Unclustered backlog: ${s.unclusteredBacklog.join(", ")}`);
  }
  if (opt.clusters) for (const c of s.clusters) out.push(`  ${c.id.padEnd(16)} ${c.name} — planned ${c.planned}/${c.items}, approved ${c.approved}/${c.items}, done ${c.done}/${c.items}`);
  else {
    const active = (m.clusters || []).map((c) => ({ c, n: Object.fromEntries(ACTIVE.map((st) => [st, c.items.filter((id) => byId.get(id)?.stage === st).length])) })).filter((x) => ACTIVE.some((st) => x.n[st]));
    for (const { c, n } of active.slice(0, 8)) out.push(`  ${c.id.padEnd(14)} ${trunc(c.name, 40).padEnd(40)} approved ${n.approved}, building ${n.building}, in review ${n.in_review} of ${c.items.length}`);
    if (active.length > 8) out.push(`  +${active.length - 8} more clusters with active work (status --clusters lists all)`);
    out.push(`${(m.clusters || []).length - active.length} other clusters, ${s.unclusteredBacklog.length} unclustered backlog items. More: status --ids | --clusters | --cluster ID`);
  }
  if (m.publish?.trackerUrl) out.push("live tracker configured: /fixit-plugin:sync keeps it current");
  console.log(out.map((l) => trunc(l)).join("\n"));
};

cmds["next-id"] = ({ pos, opt }) => {
  const L = Ledger.locate(opt).need();
  if (!pos[0] || !/^[A-Z][A-Z0-9]*$/.test(pos[0])) die("Usage: next-id PREFIX (upper-case, e.g. SEC)");
  console.log(L.nextId(pos[0], +(opt.count || 1)).join("\n"));
};

cmds.reserve = ({ pos, opt }) => {
  const L = Ledger.locate(opt).need();
  const m = L.meta();
  const prefix = pos[0], from = +opt.from, to = +opt.to;
  if (!prefix || !from || !to || to < from) die("Usage: reserve PREFIX --from N --to M --owner SESSION");
  const clash = (m.reservedIds || []).find((r) => r.prefix === prefix && !(to < r.from || from > r.to));
  if (clash) die(`${prefix}-${from}..${to} overlaps the range reserved by ${clash.owner}.`);
  m.reservedIds = [...(m.reservedIds || []), { prefix, from, to, owner: opt.owner || "", at: now() }];
  L.saveMeta(m);
  console.log(`Reserved ${prefix}-${from}..${prefix}-${to} for ${opt.owner || "(unnamed)"}.`);
};

function readInputJSON(opt) {
  if (!opt.json) die("Pass --json FILE (or --json - for stdin).");
  const raw = opt.json === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(opt.json, "utf8");
  return JSON.parse(raw);
}

function createItems(L, list, by, say) {
  for (const o of list) {
    if (!o.id || !ID_RE.test(o.id)) die(`Bad or missing id ${o.id}`);
    if (o.stage && (PAST_GATE.has(o.stage) || o.stage === "approved")) die(`${o.id}: new items cannot start past the gate.`);
    if (o.plan?.approvedAt || o.plan?.approvedBy) die(`${o.id}: a new item cannot carry an approval; the owner runs remedy approve.`);
    const i = blankItem({ ...o, order: o.order ?? L.nextOrder("item") });
    addHistory(i, { action: "Created", stage: i.stage, note: o.createdNote || "" }, by);
    L.createItem(i);
    if (i.cluster) addToCluster(L, i.cluster, i.id);
    say(`Created ${i.id}.`);
  }
}
function createRows(L, list, by, say) {
  for (const o of list) {
    if (!o.key || !ID_RE.test(o.key)) die(`Bad or missing key ${o.key}`);
    const r = blankRow({ ...o, order: o.order ?? L.nextOrder("row") });
    addHistory(r, { status: r.status, note: "Added" }, by);
    L.createRow(r);
    say(`Added register row ${r.key}.`);
  }
}
cmds["add-item"] = ({ opt }) => createItems(Ledger.locate(opt).need(), [].concat(readInputJSON(opt)), opt.by, console.log);
cmds["add-row"] = ({ opt }) => createRows(Ledger.locate(opt).need(), [].concat(readInputJSON(opt)), opt.by, console.log);

cmds.show = ({ pos, opt }) => {
  const L = Ledger.locate(opt).need();
  const i = L.item(pos[0]);
  const r = i.registerKey ? L.row(i.registerKey) : null;
  const lean = (x) => { if (!x || opt.history) return x; const { history, ...rest } = x; return { ...rest, historyEntries: (history || []).length }; };
  console.log(JSON.stringify({ item: lean(i), register: lean(r) }, null, 2));
};

function addToCluster(L, cid, id, name) {
  const m = L.meta();
  let c = (m.clusters || []).find((x) => x.id === cid);
  if (!c) { c = { id: cid, name: name || cid, items: [] }; m.clusters = [...(m.clusters || []), c]; }
  if (!c.items.includes(id)) c.items.push(id);
  L.saveMeta(m);
}

cmds.cluster = ({ pos, opt }) => {
  const L = Ledger.locate(opt).need();
  const cid = pos[0];
  if (!cid || !/^[A-Z][A-Z0-9-]*$/.test(cid)) die("Usage: cluster ID --name NAME [--items A,B] [--add A] [--remove A]");
  const m = L.meta();
  let c = (m.clusters || []).find((x) => x.id === cid);
  if (!c) { c = { id: cid, name: opt.name || cid, items: [] }; m.clusters = [...(m.clusters || []), c]; }
  if (opt.name) c.name = opt.name;
  const set = (ids) => ids.split(",").map((s) => s.trim()).filter(Boolean);
  const before = new Set(c.items);
  if (opt.items) c.items = set(opt.items);
  if (opt.add) for (const id of set(opt.add)) if (!c.items.includes(id)) c.items.push(id);
  if (opt.remove) c.items = c.items.filter((id) => !set(opt.remove).includes(id));
  L.saveMeta(m);
  for (const id of new Set([...before, ...c.items])) {
    const p = L.itemPath(id); if (!L._has(p)) continue;
    const i = L._read(p);
    const want = c.items.includes(id) ? cid : (i.cluster === cid ? "" : i.cluster);
    if (i.cluster !== want) {
      if (want && i.cluster && i.cluster !== cid) { const old = m.clusters.find((x) => x.id === i.cluster); if (old) { old.items = old.items.filter((x) => x !== id); L.saveMeta(m); } }
      i.cluster = want; L.saveItem(i);
    }
  }
  console.log(`Cluster ${cid} (${c.name}): ${c.items.join(", ") || "(empty)"}`);
};

cmds["set-plan"] = ({ pos, opt }) => {
  const L = Ledger.locate(opt).need();
  const i = L.item(pos[0]);
  if (!opt.path || !opt.summary) die("Usage: set-plan ID --path P --summary S [--risk R]");
  if (opt.risk !== undefined && !route.RISKS.includes(opt.risk)) die(`--risk takes one of: ${route.RISKS.join(", ")}.`);
  if (!fs.existsSync(path.join(L.root, opt.path))) die(`Plan file ${opt.path} does not exist. Write it first.`);
  if (PAST_GATE.has(i.stage)) die(`${i.id} is ${i.stage}; changing its plan now needs a new item or an explicit re-plan (stage it back first).`);
  const wasApproved = !!i.plan?.approvedAt;
  const changed = opt.path !== i.plan?.path || opt.summary !== i.plan?.summary;
  i.plan = { ...i.plan, path: opt.path, summary: opt.summary };
  if (wasApproved && changed) { i.plan.approvedAt = ""; i.plan.approvedBy = ""; }
  i.stage = "plan_review";
  if (opt.risk) i.risk = opt.risk;
  if (opt["pinned-by"] !== undefined || opt.pinnedBy !== undefined) i.pinnedBy = String(opt["pinned-by"] ?? opt.pinnedBy);
  const deps = opt["depends-on"] ?? opt.dependsOn;
  if (deps !== undefined) i.dependsOn = (Array.isArray(deps) ? deps : String(deps).split(",")).map((x) => String(x).trim()).filter(Boolean);
  addHistory(i, { action: wasApproved && changed ? "Plan revised (approval withdrawn)" : "Plan written", stage: "plan_review", note: `Plan: ${opt.path}` }, opt.by);
  L.saveItem(i);
  console.log(`${i.id} → plan_review${wasApproved && changed ? " (previous approval withdrawn — owner must approve again)" : ""}.`);
};

function stageCheck(i, st) {
  if (PAST_GATE.has(st) && !i.plan?.approvedAt) die(`${i.id} can't move to ${st}: its plan has not been approved. Gate closed.`);
  if (st === "plan_review" && !i.plan?.path) die(`${i.id} has no plan; use set-plan.`);
}
function stageApply(L, i, st, { note, by, noteField = true, noSync }) {
  if (["backlog", "planning"].includes(st) && i.plan?.approvedAt) { i.plan.approvedAt = ""; i.plan.approvedBy = ""; }
  const from = i.stage;
  i.stage = st;
  if (note && noteField) i.note = note;
  addHistory(i, { action: `Stage ${from} → ${st}`, stage: st, note: note || "" }, by);
  L.saveItem(i);
  if (i.registerKey && !noSync) syncOne(L, i);
  return from;
}
cmds.stage = ({ pos, opt }) => {
  const L = Ledger.locate(opt).need();
  const st = pos[1];
  const ids = [...new Set((pos[0] || "").split(",").map((x) => x.trim()).filter(Boolean))];
  if (!ids.length || !st) die("Usage: stage ID[,ID...] STAGE [--note N]");
  if (!STAGES.includes(st)) die(`Unknown stage ${st}. One of: ${STAGES.join(", ")}`);
  if (st === "approved") die("Use `approve` to record an approval (owner only).");
  const items = [], refused = [];
  for (const id of ids) { try { const i = L.item(id); stageCheck(i, st); items.push(i); } catch (e) { if (!(e instanceof UserError)) throw e; refused.push(e.message); } }
  if (refused.length) die(ids.length === 1 ? refused[0] : `${refused.length} of ${ids.length} refused, nothing changed:\n  ${refused.join("\n  ")}`);
  const froms = items.map((i) => stageApply(L, i, st, { note: opt.note === true ? "" : opt.note, by: opt.by }));
  console.log(items.length === 1 ? `${items[0].id}: ${froms[0]} → ${st}.` : `${items.length} items → ${st}.`);
};

// remedy run removes any approval that appears while it runs (see run.cjs), so refuse here rather than lose the owner's.
function refuseDuringRun(L, what) {
  const active = require("./run.cjs").activeRuns(fs.realpathSync(L.root));
  if (active.length) die(`${what} has to wait until no remedy run is active (now building ${active.map((a) => a.key).join(", ")}). An approval made during a run would be removed when it ends.`);
}

cmds.approve = ({ pos, opt }) => {
  const L = Ledger.locate(opt).need();
  refuseDuringRun(L, "Approving");
  const i = L.item(pos[0]);
  if (!opt.by || opt.by === true) die("approve needs --by <owner name>. Approval is the owner's decision; agents must not run this unless the owner explicitly told them to approve this item.");
  if (!i.plan?.path) die(`${i.id} has no plan to approve.`);
  if (!["plan_review", "planning"].includes(i.stage)) die(`${i.id} is ${i.stage}; only items in plan_review can be approved.`);
  i.plan = { ...i.plan, approvedAt: now(), approvedBy: opt.by };
  i.stage = "approved";
  if (opt.note) i.note = opt.note;
  addHistory(i, { action: "Plan approved", stage: "approved", note: opt.note || "" }, opt.by);
  L.saveItem(i);
  console.log(`${i.id} approved by ${opt.by}. Building may start.`);
};

cmds["request-changes"] = ({ pos, opt }) => {
  const L = Ledger.locate(opt).need();
  const i = L.item(pos[0]);
  if (!opt.note || opt.note === true) die("request-changes needs --note saying what the plan should change.");
  i.plan = { ...i.plan, approvedAt: "", approvedBy: "" };
  i.stage = "planning";
  i.note = opt.note;
  addHistory(i, { action: "Changes requested", stage: "planning", note: opt.note }, opt.by);
  L.saveItem(i);
  console.log(`${i.id} sent back to planning.`);
};

cmds.note = ({ pos, opt }) => {
  const L = Ledger.locate(opt).need();
  const i = L.item(pos[0]);
  i.note = pos.slice(1).join(" ");
  addHistory(i, { action: "Note", stage: i.stage, note: i.note }, opt.by);
  L.saveItem(i);
  console.log(`Noted on ${i.id}.`);
};

function syncOne(L, i) {
  const r = L.row(i.registerKey);
  if (!r) return false;
  const want = STAGE_TO_STATUS[i.stage];
  if (i.stage === "blocked" || r.status === want) return false;
  const from = r.status;
  r.status = want;
  addHistory(r, { status: want, note: `Mirrored from tracker ${i.id} (${i.stage})` }, "");
  L.saveRow(r);
  return { key: r.key, from, to: want };
}
function mirrorAll(L, dry) {
  const out = [];
  for (const i of L.items()) {
    if (!i.registerKey) continue;
    const r = L.row(i.registerKey); if (!r) continue;
    const want = STAGE_TO_STATUS[i.stage];
    if (i.stage === "blocked" || r.status === want) continue;
    out.push(dry ? { key: r.key, from: r.status, to: want } : syncOne(L, L.item(i.id)));
  }
  return out;
}
cmds["sync-register"] = ({ opt }) => {
  const out = mirrorAll(Ledger.locate(opt).need(), opt["dry-run"]);
  console.log(out.length ? out.map((c) => `${c.key}: ${c.from} → ${c.to}`).join("\n") : "Register already in step.");
};

// ── plans: find one item's section in its plan document ──
const PLAN_KEYS = ["Decision", "Fix", "Files", "Tests", "Acceptance"];
const headLevel = (l) => (/^(#{1,6})\s/.exec(l) || [])[1]?.length || 0;
function wrap(text, width = 200) {
  const out = [], indent = /^\s*/.exec(text)[0];
  let rest = text.replace(/\s+$/, "");
  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut < width / 2) cut = width;
    out.push(rest.slice(0, cut));
    rest = indent + "  " + rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out;
}
// Returns { layout, label, lines: [{n, text}] } (1-based source line numbers, blank lines dropped) or null.
function findSection(plan, id) {
  const lines = plan.lines, idRe = new RegExp(`(?<![A-Z0-9-])${id}(?![0-9])`);
  const span = (a, b) => { const out = []; for (let n = a; n <= b; n++) if (lines[n - 1].trim()) out.push({ n, text: lines[n - 1] }); return out; };
  const headEnd = (k, lvl) => { let e = k + 1; while (e < lines.length && !(headLevel(lines[e]) && headLevel(lines[e]) <= lvl)) e++; return e; }; // 1-based inclusive end
  if (path.basename(plan.path) === `${id}.md`) {
    const got = [], rc = [];
    lines.forEach((l, k) => {
      const lvl = headLevel(l); if (!lvl || lvl > 2) return;
      const title = l.replace(/^#+\s*/, "");
      const key = PLAN_KEYS.find((x) => new RegExp("^" + x, "i").test(title));
      if (key) got.push({ key, lines: span(k + 1, headEnd(k, lvl)) });
      else if (/^root cause/i.test(title)) rc.push(...span(k + 1, headEnd(k, lvl)));
    });
    if (!got.length) return lines.length <= 40 ? { layout: "item", label: "whole file", lines: span(1, lines.length) } : null; // the file is this item's plan
    return { layout: "item", label: `sections ${got.map((g) => g.key).join(", ")}`, lines: got.flatMap((g) => g.lines), extra: rc };
  }
  const startsWithId = (t) => new RegExp(`^\\W*${id}(?![0-9])`).test(t);
  let k = lines.findIndex((l) => headLevel(l) && startsWithId(l.replace(/^#+\s*/, "")));
  if (k >= 0) { const e = headEnd(k, headLevel(lines[k])); return { layout: "heading", lines: span(k + 1, e), range: [k + 1, e] }; }
  k = lines.findIndex((l) => new RegExp(`^\\s*[-*]\\s+\\*\\*${id}(?![0-9])`).test(l));
  if (k >= 0) {
    const ind = /^\s*/.exec(lines[k])[0].length;
    let e = k + 1;
    while (e < lines.length && (!lines[e].trim() || (/^\s*/.exec(lines[e])[0].length > ind && !headLevel(lines[e])))) e++;
    while (e > k + 1 && !lines[e - 1].trim()) e--;
    return { layout: "bullet", lines: span(k + 1, e), range: [k + 1, e] };
  }
  k = lines.findIndex((l) => headLevel(l) && idRe.test(l));
  if (k >= 0) { const e = headEnd(k, headLevel(lines[k])); return { layout: "heading", lines: span(k + 1, e), range: [k + 1, e] }; }
  return null;
}
function loadPlan(L, i) {
  const p = i.plan?.path;
  if (!p) return null;
  const f = path.join(L.root, p);
  return fs.existsSync(f) ? { path: p, lines: fs.readFileSync(f, "utf8").replace(/\n+$/, "").split("\n") } : { path: p, lines: null };
}
// pinnedBy is written four ways: "path › name", "path · name (marker)", "path (name / marker)", "path (name)".
function parsePinned(v) {
  if (!v) return null;
  const file = (x) => (/^[^\s]+$/.test(x) && /[./]/.test(x) ? x : null);
  let m;
  if ((m = v.split(" › ")).length === 2 && file(m[0].trim())) return { file: m[0].trim(), name: m[1].trim() };
  if ((m = v.split(" · ")).length === 2 && file(m[0].trim())) return { file: m[0].trim(), name: m[1].replace(/\s*\([^)]*\)\s*$/, "").trim() };
  if ((m = /^(\S+) \((.+?) \/ .+\)$/.exec(v)) && file(m[1])) return { file: m[1], name: m[2].trim() };
  if ((m = /^(\S+) \((.+)\)$/.exec(v)) && file(m[1])) return { file: m[1], name: m[2].trim() }; // "path (name)", as planners write it
  return null;
}

// ── brief, route, escalate ──
cmds.brief = ({ pos, opt }) => {
  const L = Ledger.locate(opt).need();
  const id = pos[0] || die("Usage: brief ID [--role builder|planner] [--json]");
  const role = opt.role === undefined ? "builder" : opt.role;
  if (!["builder", "planner"].includes(role)) die("--role takes builder or planner.");
  const i = L.item(id), m = L.meta();
  const out = [`${i.id}  ${i.title}`];
  if (role === "planner") {
    out.push(route.routeLine(route.resolveRole("planner", m.models)));
    out.push(`stage ${i.stage}  severity ${i.severity}  kind ${i.kind}  wave ${i.wave || "-"}  cluster ${i.cluster || "-"}`);
    if (i.summary) out.push(...wrap(`summary: ${i.summary}`).slice(0, 10));
    out.push(...(i.sources || []).slice(0, 8).map((x) => trunc(`source: ${x}`)));
    if (i.sources?.length > 8) out.push(`+${i.sources.length - 8} more sources: remedy show ${i.id}`);
    if (i.note) out.push(...wrap(`note: ${i.note}`).slice(0, 6));
    return console.log(opt.json ? JSON.stringify({ id: i.id, title: i.title, stage: i.stage, summary: i.summary, sources: i.sources, note: i.note }, null, 2) : out.join("\n"));
  }
  if (!i.plan?.approvedAt) die(`GATE CLOSED: ${i.id} has no recorded plan approval (stage ${i.stage}). The owner must run: remedy approve ${i.id} --by "<name>"`);
  const plan = loadPlan(L, i);
  const sec = plan?.lines ? findSection(plan, i.id) : null;
  const r = route.resolveItem(i, m.models, sec ? sec.lines.map((x) => x.text).join("\n") : "");
  const deps = (i.dependsOn || []).map((d) => { let x; try { x = L.item(d); } catch { return `${d} (not in ledger) BLOCKED`; } return `${d} ${x.stage}${x.stage === "done" ? "" : " BLOCKED"}`; });
  const head = [out[0], route.routeLine(r),
    `stage ${i.stage}  severity ${i.severity}  kind ${i.kind}  wave ${i.wave || "-"}  cluster ${i.cluster || "-"}  gate: approved by ${i.plan.approvedBy || "?"} ${(i.plan.approvedAt || "").slice(0, 10)}`,
    `depends: ${deps.length ? deps.join(", ") : "none"}`];
  if (r.mode) head.push("mode: mechanical (make only the listed edits; anything needing a choice is plan-drift)");
  const pin = parsePinned(i.pinnedBy);
  const tail = [];
  if (i.pinnedBy) tail.push(pin ? `pinned: fixit test ${pin.file} --grep "${pin.name}"` : `pinned: ${i.pinnedBy}`);
  tail.push("before commit: fixit test --changed");
  if (process.env.REMEDY_RUN_ITEM) { const b = cp.spawnSync("git", ["branch", "--show-current"], { encoding: "utf8" }).stdout?.trim(); if (b) tail.push(`branch: ${b} (the run's worktree; commit here)`); }
  const runMd = path.join(L.dir, "runs", `${i.id}.md`);
  let setup = ""; try { setup = readJSON(path.join(L.root, "fixit.config.json")).worktree?.setup || ""; } catch { /* no config */ }
  const prior = [fs.existsSync(runMd) ? `prior report: remedy report ${i.id} --show` : "", setup ? `setup: ${setup}` : ""].filter(Boolean);
  if (prior.length) tail.push(prior.join("   "));
  tail.push(`finish: remedy report ${i.id}   |   remedy done ${i.id} --commit <sha>`);
  // The plan, within 40 lines in all.
  const body = [], total = plan?.lines ? plan.lines.length : 0;
  const summary = i.plan.summary ? wrap(`summary: ${i.plan.summary}`).slice(0, 6) : [];
  let planLine, secLines = [];
  if (!plan) planLine = "plan: none recorded";
  else if (!plan.lines) planLine = `plan: ${plan.path} (file not found)`;
  else if (sec) {
    secLines = sec.lines;
    if (sec.layout === "item") { const room = 40 - head.length - tail.length - summary.length - 3 - secLines.length; if (room > 0 && sec.extra?.length) secLines = [...secLines, ...sec.extra.slice(0, room)]; }
    const a = secLines[0]?.n, b = secLines[secLines.length - 1]?.n;
    planLine = sec.layout === "item" ? `plan: ${plan.path} ${sec.label} (whole doc ${total} lines)` : `plan: ${plan.path} lines ${a}-${b} (section only; whole doc ${total} lines)`;
  } else if (total <= 40) planLine = `plan: ${plan.path} (${total}-line overview; the plan is the summary above)`;
  else planLine = `plan: ${plan.path} (${total} lines)\nSECTION NOT FOUND: read ${plan.path}`;
  let room = 40 - head.length - 1 - tail.length - summary.length - planLine.split("\n").length - 1, last = 0;
  for (const l of secLines) {
    const w = wrap(l.text);
    if (w.length > room && !(body.length === 0 && room > 0)) break;
    body.push(...w.slice(0, room)); room -= Math.min(w.length, room); last = l.n;
  }
  const left = secLines.filter((l) => l.n > last);
  if (left.length) body.push(`+${left.length} lines: sed -n '${left[0].n},${left[left.length - 1].n}p' ${plan.path}`);
  const text = [...head, planLine, ...summary, ...body, ...tail];
  if (opt.json) return console.log(JSON.stringify({ id: i.id, title: i.title, route: r, stage: i.stage, severity: i.severity, kind: i.kind, wave: i.wave, cluster: i.cluster, approvedBy: i.plan.approvedBy, approvedAt: i.plan.approvedAt, dependsOn: deps, plan: { path: plan?.path, summary: i.plan.summary, section: secLines.map((x) => x.text), from: secLines[0]?.n, to: secLines[secLines.length - 1]?.n, total }, pinned: pin || i.pinnedBy, text }, null, 2));
  console.log(text.map((l) => (l.includes("\n") ? l : trunc(l))).join("\n"));
};

cmds.route = ({ pos, opt }) => {
  const L = Ledger.locate(opt).need();
  const m = L.meta();
  try {
    if (opt.role !== undefined) return console.log(route.routeLine(route.resolveRole(String(opt.role), m.models)));
    if (opt.cluster !== undefined) {
      const c = (m.clusters || []).find((x) => x.id === opt.cluster) || die(`No cluster ${opt.cluster}.`);
      if (!c.items.length) die(`Cluster ${c.id} has no items.`);
      const rs = c.items.map((id) => { const i = L.item(id); const plan = loadPlan(L, i), sec = plan?.lines ? findSection(plan, id) : null; return route.resolveItem(i, m.models, sec ? sec.lines.map((x) => x.text).join("\n") : ""); });
      const top = route.highest(rs);
      return console.log(route.routeLine({ ...top, reason: `cluster ${c.id}, highest of ${rs.length} items: ${top.reason}` }));
    }
  } catch (e) { if (e instanceof UserError) throw e; die(e.message); }
  const id = pos[0] || die("Usage: route ID | route --role R | route --cluster C | route ID --set ALIAS --by WHO --reason R");
  const i = L.item(id);
  if (opt.set !== undefined) {
    if (!route.ALIASES.includes(opt.set)) die(`--set takes ${route.ALIASES.join(", ")}.`);
    if (!opt.by || opt.by === true || !opt.reason || opt.reason === true) die("route --set needs --by WHO and --reason R.");
    i.model = opt.set;
    addHistory(i, { action: `Model pinned to ${opt.set}`, stage: i.stage, note: opt.reason }, opt.by);
    L.saveItem(i);
  }
  const plan = loadPlan(L, i), sec = plan?.lines ? findSection(plan, id) : null;
  console.log(route.routeLine(route.resolveItem(i, m.models, sec ? sec.lines.map((x) => x.text).join("\n") : "")));
};

cmds.escalate = ({ pos, opt }) => {
  const L = Ledger.locate(opt).need();
  const i = L.item(pos[0] || die("Usage: escalate ID --reason R [--model ALIAS]"));
  if (!opt.reason || opt.reason === true) die("escalate needs --reason R (what failed, twice).");
  const model = escalateItem(L, i, opt.model, opt.reason, opt.by);
  console.log(`${i.id}: escalated to ${model}; a fresh builder starts from ${path.relative(L.root, path.join(L.dir, "runs", i.id + ".md"))}.`);
};
function escalateItem(L, i, wanted, reason, by) {
  const model = wanted === undefined ? route.modelFor(L.meta().models, "builder-escalation") : wanted;
  if (!route.MODEL_VALUES.includes(model)) die(`--model takes ${route.MODEL_VALUES.join(", ")}.`);
  i.escalation = { model, reason, at: now() };
  addHistory(i, { action: `Escalated to ${model}`, stage: i.stage, note: reason }, by);
  L.saveItem(i);
  return model;
}
function routeOf(L, m, i) {
  const plan = loadPlan(L, i), sec = plan?.lines ? findSection(plan, i.id) : null;
  return route.resolveItem(i, m.models, sec ? sec.lines.map((x) => x.text).join("\n") : "");
}
// Reports and handoffs go in git with the ledger, if the project tracks its ledger. The raw results of a run do not.
// Only ever adds to the ledger's own .gitignore; a project that ignores all of .remedy/ is not affected.
function ensureRunsIgnored(L) {
  const f = path.join(L.dir, ".gitignore"), line = "runs/*.json";
  const had = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  if (had.split("\n").some((l) => l.trim() === line)) return;
  fs.writeFileSync(f, (had && !had.endsWith("\n") ? had + "\n" : had) + line + "\n");
}

// ── done, report ──
function mainBranchOf(L, m) {
  if (m.mainBranch) return m.mainBranch;
  try { return cp.execFileSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: L.root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return "main"; }
}
// A green run, as `fixit test` records it in .fixit/runs/<id>/meta.json: exitCode 0, result pass or flaky, and the
// pinned file among meta.files (every test file the run reported) or meta.target (the file asked for). A run with
// --grep counts only if the grep names the pinned test. Runs live in the main checkout's .fixit (FIXIT_DIR overrides).
function hasGreenRun(L, pin) {
  const dir = path.join(process.env.FIXIT_DIR ? path.resolve(process.env.FIXIT_DIR) : path.join(mainRoot(L.root), ".fixit"), "runs");
  if (!fs.existsSync(dir)) return false;
  const norm = (f) => String(f || "").replace(/^\.\//, "");
  const want = norm(pin.file);
  for (const d of fs.readdirSync(dir)) {
    let r; try { r = readJSON(path.join(dir, d, "meta.json")); } catch { continue; }
    if (r.exitCode !== 0 || (r.result !== "pass" && r.result !== "flaky")) continue;
    if (r.grep && !String(pin.name || "").includes(r.grep) && !String(r.grep).includes(pin.name || "\0")) continue;
    if (norm(r.target) === want || (Array.isArray(r.files) && r.files.some((f) => norm(f) === want))) return true;
  }
  return false;
}
cmds.done = ({ pos, opt }) => {
  const L = Ledger.locate(opt).need();
  const ids = [...new Set((pos[0] || "").split(",").map((x) => x.trim()).filter(Boolean))];
  if (!ids.length || !opt.commit || opt.commit === true) die("Usage: done ID[,ID...] --commit SHA");
  const m = L.meta(), main = mainBranchOf(L, m), git = (...a) => cp.spawnSync("git", a, { cwd: L.root, encoding: "utf8" });
  const sha = git("rev-parse", "--verify", "--quiet", opt.commit + "^{commit}").stdout.trim() || die(`Commit ${opt.commit} not found in ${L.root}.`);
  const anc = git("merge-base", "--is-ancestor", sha, main);
  if (anc.status !== 0 && anc.status !== 1) die(`Cannot compare with the main branch "${main}": ${anc.stderr.trim()}. Set meta.mainBranch.`);
  const to = anc.status === 0 ? "done" : "in_review";
  const items = ids.map((id) => L.item(id)), refused = [];
  for (const i of items) { if (!["approved", "building", "in_review"].includes(i.stage)) refused.push(`${i.id} is ${i.stage}; done needs building, in_review or approved.`); else try { stageCheck(i, to); } catch (e) { refused.push(e.message); } }
  if (refused.length) die(`nothing changed:\n  ${refused.join("\n  ")}`);
  const froms = items.map((i) => stageApply(L, i, to, { note: `commit ${sha.slice(0, 7)} (${to === "done" ? "on" : "not on"} ${main})`, by: opt.by, noteField: false }));
  const errors = validate(L).errors.length;
  renderDashboard(L, {});
  items.forEach((i, k) => {
    console.log(`${i.id}: ${froms[k]} → ${to} at ${sha.slice(0, 7)}${to === "in_review" ? ` (not on ${main})` : ""}; ${errors} errors; dashboard written`);
    const pin = parsePinned(i.pinnedBy);
    if (pin && !hasGreenRun(L, pin)) console.log(`warn: no green fixit run found for ${i.id}'s pinned test ${pin.file}; run: fixit test ${pin.file} --grep "${pin.name}"`);
  });
  if (errors) process.exitCode = 1;
};

cmds.report = ({ pos, opt }) => {
  const L = Ledger.locate(opt).need();
  const id = pos[0] || die("Usage: report ID [--show]   (report text on stdin)");
  L.item(id);
  const f = path.join(L.dir, "runs", id + ".md"), rel = path.relative(L.root, f);
  if (opt.show) {
    if (!fs.existsSync(f)) die(`No report at ${rel}.`);
    const ls = fs.readFileSync(f, "utf8").replace(/\n+$/, "").split("\n");
    console.log([...ls.slice(0, 40).map((l) => trunc(l)), ...(ls.length > 40 ? [`+${ls.length - 40} lines: sed -n '41,${ls.length}p' ${rel}`] : [])].join("\n"));
    return;
  }
  if (process.stdin.isTTY) die("Pipe the report on stdin: remedy report ID <<'EOF' ... EOF");
  const text = fs.readFileSync(0, "utf8");
  if (!text.trim()) die("The report on stdin is empty.");
  writeText(f, text.endsWith("\n") ? text : text + "\n");
  console.log(`report: ${rel} (${text.trimEnd().split("\n").length} lines)`);
};

// ── handoff: what a fresh session needs, from the files ──
const handoffName = /^\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?\.md$/;
function handoffFiles(L) {
  const dir = path.join(L.dir, "handoff");
  const stem = (f) => f.replace(/\.md$/, "");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => handoffName.test(f)).sort((a, b) => (stem(a) < stem(b) ? -1 : 1)).map((f) => path.join(dir, f)) : [];
}
// status: and commit: from a report, the worker's own words.
function reportFields(L, id) {
  try {
    const t = fs.readFileSync(path.join(L.dir, "runs", id + ".md"), "utf8");
    const get = (k) => (new RegExp(`^\\s*${k}:\\s*(.+)$`, "im").exec(t) || [])[1]?.trim().slice(0, 60) || "";
    return { status: get("status"), branch: get("branch"), commit: get("commit") };
  } catch { return { status: "", branch: "", commit: "" }; }
}
cmds.handoff = ({ opt }) => {
  const L = Ledger.locate(opt).need(), all = handoffFiles(L);
  if (opt.latest) {
    if (!all.length) return console.log("no handoff yet.");
    const f = all[all.length - 1], ls = fs.readFileSync(f, "utf8").replace(/\n+$/, "").split("\n"), rel = path.relative(L.root, f);
    return console.log([...ls.slice(0, 60).map((l) => trunc(l)), ...(ls.length > 60 ? [`+${ls.length - 60} lines: sed -n '61,${ls.length}p' ${rel}`] : [])].join("\n"));
  }
  const fromText = opt.from === undefined ? "" : opt.from === true ? die("--from needs FILE or -.") : opt.from === "-" ? (process.stdin.isTTY ? die("Pipe the text on stdin, or use --next and --open.") : fs.readFileSync(0, "utf8")) : fs.readFileSync(opt.from, "utf8");
  const m = L.meta(), items = L.items(), counts = {};
  for (const i of items) counts[i.stage] = (counts[i.stage] || 0) + 1;
  const pad = (n) => String(n).padStart(2, "0"), d = new Date();
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const dir = path.join(L.dir, "handoff");
  let f = path.join(dir, stamp + ".md");
  for (let n = 2; fs.existsSync(f); n++) f = path.join(dir, `${stamp}-${n}.md`);
  const since = all.length ? fs.statSync(all[all.length - 1]).mtimeMs : 0;
  const git = (...a) => { const r = cp.spawnSync("git", a, { cwd: L.root, encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : ""; };
  const lines = [`# Handoff ${stamp}`, `${m.title || "Programme"}: branch ${git("rev-parse", "--abbrev-ref", "HEAD") || "-"} at ${git("rev-parse", "--short", "HEAD") || "-"}`,
    `stages: ${STAGES.filter((s) => counts[s]).map((s) => `${s} ${counts[s]}`).join(", ") || "no items"}`, "", "## In flight"];
  const flight = items.filter((i) => ["building", "in_review", "blocked"].includes(i.stage));
  for (const i of flight.slice(0, 20)) {
    const r = reportFields(L, i.id), hist = [...(i.history || [])].reverse().map((h) => /commit ([0-9a-f]{7,})/.exec(h.note || "")).find(Boolean);
    lines.push(trunc(`- ${i.id} ${i.stage}: branch ${r.branch || "-"}, commit ${r.commit || hist?.[1] || "-"}${r.status ? `, report says ${r.status}` : ""}. ${i.title}`));
  }
  if (flight.length > 20) lines.push(`- +${flight.length - 20} more: remedy status --ids`);
  if (!flight.length) lines.push("- none");
  lines.push("", "## Run reports since the last handoff");
  const runsDir = path.join(L.dir, "runs");
  const fresh = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((x) => x.endsWith(".md") && fs.statSync(path.join(runsDir, x)).mtimeMs > since).sort() : [];
  for (const x of fresh.slice(0, 15)) lines.push(trunc(`- ${path.basename(x, ".md")}: ${reportFields(L, path.basename(x, ".md")).status || "no status"}, remedy report ${path.basename(x, ".md")} --show`));
  if (fresh.length > 15) lines.push(`- +${fresh.length - 15} more in ${path.relative(L.root, runsDir)}`);
  if (!fresh.length) lines.push("- none");
  if (!fromText.trim() || (opt.next && opt.next !== true)) lines.push("", "## Next step", opt.next && opt.next !== true ? String(opt.next) : "(none given)");
  const open = opt.open ? [].concat(opt.open) : [];
  if (open.length) lines.push("", "## Open questions", ...open.map((q) => `- ${q}`));
  if (fromText.trim()) lines.push("", "## From the lead", fromText.trimEnd());
  writeText(f, lines.join("\n") + "\n");
  console.log(`handoff: ${path.relative(L.root, f)} (${lines.length} lines)\nresume: start a fresh session with claude, then run: remedy handoff --latest`);
};

cmds.run = (a) => require("./run.cjs").main(a, { Ledger, die, stageApply, addHistory, routeOf, ensureRunsIgnored, mainBranchOf, escalateItem });

// ── intake: security-audit findings.json ──
const SEV_MAP = { critical: "critical", high: "high", medium: "medium", low: "low", informational: "low" };
function fmtTrace(t) { return `${t.file}:${t.line} · ${t.kind} · ${t.description}`.slice(0, 300); }
cmds["import-findings"] = ({ pos, opt }) => {
  const L = Ledger.locate(opt).need();
  const file = pos[0] || die("Usage: import-findings path/to/findings.json");
  const findings = readJSON(file);
  if (!Array.isArray(findings)) die("findings.json must be an array (security-audit report-schema.json).");
  const prefix = opt.prefix || "SEC";
  const fpIndex = new Map();
  for (const x of [...L.items(), ...L.rows()]) if (x.fingerprint) fpIndex.set(x.fingerprint, x.id || x.key);
  const foundBy = opt["found-by"] || `Security audit (${path.basename(path.dirname(path.resolve(file)))})`;
  const report = { created: [], carried: [], rejected: 0, validation: [] };
  for (const f of findings) {
    if (f.verdict === "rejected") { report.rejected++; continue; }
    if (fpIndex.has(f.fingerprint)) { report.carried.push(`${f.fingerprint} → ${fpIndex.get(f.fingerprint)}`); continue; }
    const [id] = L.nextId(prefix);
    const sources = [...(f.trace || []).map(fmtTrace), ...(f.evidence || []).map((e) => `${e.file}:${e.line} · ${e.description}`.slice(0, 300))];
    const pinned = "";
    if (f.verdict === "confirmed") {
      const sev = SEV_MAP[f.severity?.overall_severity] || "unrated";
      const row = blankRow({
        key: id, title: f.title, detail: f.description, impact: f.severity?.impact?.reason || "",
        location: (f.trace || []).filter((t) => t.kind === "sink").map((t) => `${t.file}:${t.line}`).join(" · ") || sources[0] || "",
        category: opt.category || "Security", component: (f.trace?.[0]?.scope) || "", severity: sev, status: "open",
        foundBy, confidence: f.confidence ? `${f.confidence.score}: ${f.confidence.reason}` : "", pinnedBy: pinned, fingerprint: f.fingerprint,
        note: "", order: L.nextOrder("row"),
      });
      if (!opt["dry-run"]) { addHistory(row, { status: "open", note: "Imported from security audit" }, ""); L.createRow(row); }
      const item = blankItem({
        id, title: f.title, summary: `${f.description} Root cause: ${f.root_cause}`.slice(0, 1200), impact: f.severity?.impact?.reason || "",
        severity: sev, kind: "bug", wave: opt.wave || (sev === "critical" ? "W0" : sev === "high" ? "W1" : "W3"),
        workstream: opt.workstream || "Security", component: row.component, sources, registerKey: id, fingerprint: f.fingerprint,
        acceptance: `Intended behaviour holds: ${f.intended_behavior}`.slice(0, 600),
        note: f.remediation?.strategy ? `Audit's suggested fix: ${f.remediation.strategy}`.slice(0, 1200) : "",
        order: L.nextOrder("item"),
      });
      if (!opt["dry-run"]) { addHistory(item, { action: "Imported", stage: "backlog", note: foundBy }, ""); L.createItem(item); }
      report.created.push(`${id} (${sev}) ${f.title}`);
    } else if (f.verdict === "needs_validation") {
      const item = blankItem({
        id, title: `Validate: ${f.title}`, summary: `${f.description} Claimed root cause: ${f.claimed_root_cause}`.slice(0, 1200),
        severity: "unrated", kind: "validation", wave: opt.wave || "W1", workstream: opt.workstream || "Security",
        sources: [...sources, ...(f.blockers || []).map((b) => `BLOCKER · ${b}`)], fingerprint: f.fingerprint,
        acceptance: `Resolved either way: ${f.validation_plan?.local || f.validation_plan?.deployment || "the blocker is answered"}`.slice(0, 600),
        note: "needs_validation from the audit: no severity until the blocker is resolved; confirm (add a register row) or reject.",
        order: L.nextOrder("item"),
      });
      if (!opt["dry-run"]) { addHistory(item, { action: "Imported", stage: "backlog", note: foundBy }, ""); L.createItem(item); }
      report.validation.push(`${id} ${f.title}`);
    }
  }
  console.log(JSON.stringify(report, null, 2));
};

// ── intake: test-campaign campaign-findings.json ──
const LAYER_PREFIX = { "http-authz": "SEC", simulation: "WF", "load-lifecycle": "WF", capacity: "PERF", "browser-e2e": "WEB", "frontend-contract": "WEB", static: "TOOL" };
const LAYER_LABEL = { "http-authz": "HTTP / authorization tests", simulation: "Workflow simulation", "load-lifecycle": "Load lifecycle", capacity: "Capacity benchmark", "browser-e2e": "Browser E2E", "frontend-contract": "Front-end tests", static: "Static sweep" };
cmds["import-campaign"] = ({ pos, opt }) => {
  const L = Ledger.locate(opt).need();
  const file = pos[0] || die("Usage: import-campaign path/to/campaign-findings.json");
  const findings = readJSON(file);
  if (!Array.isArray(findings)) die("campaign-findings.json must be an array (test-campaign campaign-findings.schema.json).");
  const fpIndex = new Map();
  for (const x of [...L.items(), ...L.rows()]) if (x.fingerprint) fpIndex.set(x.fingerprint, x.id || x.key);
  const report = { created: [], leads: [], carried: [], invalid: [] };
  for (const f of findings) {
    const bad = ["fingerprint", "verdict", "title", "detail", "layer"].filter((k) => !f[k]);
    if (f.verdict === "confirmed" && !SEVERITIES.includes(f.severity)) bad.push("severity");
    if (bad.length) { report.invalid.push(`${f.fingerprint || f.title || "?"}: missing ${bad.join(", ")}`); continue; }
    if (fpIndex.has(f.fingerprint)) { report.carried.push(`${f.fingerprint} → ${fpIndex.get(f.fingerprint)}`); continue; }
    const prefix = opt.prefix || LAYER_PREFIX[f.layer] || "BUG";
    const [id] = L.nextId(prefix);
    const foundBy = opt["found-by"] || `Test campaign · ${LAYER_LABEL[f.layer] || f.layer}`;
    const kind = f.kind || (f.layer === "capacity" ? "perf" : "bug");
    const location = (f.location || []).join(" · ");
    const sources = [...(f.location || []), ...(f.reproduction ? [`repro · ${f.reproduction}`] : [])];
    if (f.verdict === "confirmed") {
      const sev = f.severity;
      const wave = opt.wave || (sev === "critical" ? "W0" : sev === "high" ? (kind === "perf" ? "W2" : "W1") : kind === "debt" || f.layer === "static" ? "W4" : "W3");
      if (!opt["dry-run"]) {
        const row = blankRow({ key: id, title: f.title, detail: f.detail, impact: f.impact || "", location, category: f.category || LAYER_LABEL[f.layer] || "", component: f.component || "", severity: sev, status: "open", foundBy, confidence: f.reproduction ? `Reproduced: ${f.reproduction}` : "", pinnedBy: f.pinnedBy || "", fingerprint: f.fingerprint, order: L.nextOrder("row") });
        addHistory(row, { status: "open", note: "Imported from test campaign" }, ""); L.createRow(row);
        const item = blankItem({ id, title: f.title, summary: f.detail, impact: f.impact || "", severity: sev, kind, wave, workstream: opt.workstream || f.category || "", component: f.component || "", sources, pinnedBy: f.pinnedBy || "", registerKey: id, fingerprint: f.fingerprint, order: L.nextOrder("item") });
        addHistory(item, { action: "Imported", stage: "backlog", note: foundBy }, ""); L.createItem(item);
      }
      report.created.push(`${id} (${f.severity}, ${f.layer}) ${f.title}`);
    } else {
      if (!opt["dry-run"]) {
        const item = blankItem({ id, title: `Validate: ${f.title}`, summary: f.detail, severity: "unrated", kind: "validation", wave: opt.wave || "W1", workstream: opt.workstream || f.category || "", component: f.component || "", sources: [...sources, ...(f.blocker ? [`BLOCKER · ${f.blocker}`] : [])], fingerprint: f.fingerprint, note: "Lead from the test campaign: reproduce deterministically, then confirm (add-row) or reject (wont_do).", order: L.nextOrder("item") });
        addHistory(item, { action: "Imported", stage: "backlog", note: foundBy }, ""); L.createItem(item);
      }
      report.leads.push(`${id} ${f.title}`);
    }
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.invalid.length) process.exitCode = 1;
};

// ── intake: test-marker scan ──
cmds.scan = ({ opt }) => {
  const root = path.resolve(opt.root || gitRoot(process.cwd()));
  const SKIP = new Set(["node_modules", ".git", "dist", "build", "coverage", ".remedy", ".next", "vendor", "target"]);
  const PAT = [
    [/\b(it|test)\.fails\s*\(/, "fails"], [/\b(it|test|describe)\.todo\s*\(/, "todo"], [/\btest\.fixme\s*\(/, "fixme"],
    [/\b(it|test|describe)\.skip\s*\(\s*["'`].*(BUG|bug|known)/, "skip-bug"], [/\bKNOWN_[A-Z0-9_]+\s*[:=]/, "ratchet"],
    [/\/\/\s*BUG[:( ]/, "bug-comment"], [/\{\s*todo:\s*["'`]/, "todo-option"], [/@pytest\.mark\.xfail/, "xfail"],
  ];
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(c?[jt]sx?|mjs|py|go|rb|rs|java|kt)$/.test(e.name)) {
        let txt; try { txt = fs.readFileSync(p, "utf8"); } catch { continue; }
        if (txt.length > 2e6) continue;
        txt.split("\n").forEach((line, n) => { for (const [re, kind] of PAT) if (re.test(line)) out.push({ file: path.relative(root, p), line: n + 1, kind, text: line.trim().slice(0, 200) }); });
      }
    }
  })(root);
  console.log(JSON.stringify(out, null, 2));
};

cmds.validate = ({ opt }) => {
  const L = Ledger.locate(opt).need();
  const { errors, warnings } = validate(L);
  const show = (label, list) => {
    if (opt.all) return list.forEach((x) => console.log(`${label} ${x}`));
    const groups = new Map();
    for (const x of list) { const mm = /^([A-Z][A-Z0-9]*-\d+): (.*)$/.exec(x); const k = mm ? mm[2] : x; (groups.get(k) || groups.set(k, []).get(k)).push(mm ? mm[1] : null); }
    for (const [msg, ids] of groups) console.log(ids.length > 1 && ids[0] ? `${label} ${ids.length} items (${ids.slice(0, 3).join(", ")}${ids.length > 3 ? ", …" : ""}): ${msg}` : `${label} ${ids[0] ? ids[0] + ": " : ""}${msg}`);
  };
  show("warn ", warnings);
  show("ERROR", errors);
  console.log(`${errors.length} error(s), ${warnings.length} warning(s).`);
  if (errors.length) process.exitCode = 1;
};

// ── dashboard ──
function renderDashboard(L, opt) {
  const tpl = fs.readFileSync(path.join(__dirname, "..", "assets", "tracker.html"), "utf8");
  const data = { meta: L.meta(), items: L.items(), bugs: L.rows(), generatedAt: now(), cli: "node " + (path.relative(L.root, __filename).startsWith("..") ? __filename : path.relative(L.root, __filename)) };
  const inject = `<script>window.__REMEDY_DATA__=${JSON.stringify(data).replace(/</g, "\\u003c")};</script>`;
  const html = tpl.replace("<!--REMEDY_DATA-->", inject);
  const out = path.resolve(opt.out || path.join(L.dir, "dashboard.html"));
  fs.writeFileSync(out, html);
  return out;
}
cmds.render = ({ opt }) => console.log(`Wrote ${renderDashboard(Ledger.locate(opt).need(), opt)}`);

// ── claude.ai artifact backend ──
cmds["export-artifact"] = ({ opt }) => {
  const L = Ledger.locate(opt).need();
  const out = path.resolve(opt.out || path.join(L.dir, "artifact-export"));
  fs.rmSync(out, { recursive: true, force: true });
  const m = L.meta();
  writeJSON(path.join(out, "meta-protocol.json"), { title: m.title, subtitle: m.subtitle, project: m.project, waves: m.waves, clusters: m.clusters, protocol: m.protocol, excluded: m.excluded, registerUrl: m.publish?.registerUrl || "", updatedAt: now() });
  writeJSON(path.join(out, "meta-register.json"), { title: (m.title || "").replace(/Tracker$/i, "Register").trim() || "Bug Register", project: m.project, subtitle: m.subtitle, trackerUrl: m.publish?.trackerUrl || "", updatedAt: now() });
  for (const i of L.items()) writeJSON(path.join(out, "items", i.id + ".json"), i);
  for (const r of L.rows()) writeJSON(path.join(out, "bugs", r.key + ".json"), r);
  console.log(`Wrote ${out} — publish items/ + meta-protocol.json to the tracker artifact (collections items, meta/protocol) and bugs/ + meta-register.json to the register artifact (collections bugs, meta/register) with ArtifactData batch writes of at most 50.`);
};

cmds["import-artifact"] = ({ opt }) => {
  const L = Ledger.locate(opt).need();
  if (opt.items) refuseDuringRun(L, "Importing items, which can carry approvals,");
  const unwrap = (o) => (o && o.data && (o.id || o.version) ? o.data : o);
  let n = 0;
  if (opt.items) for (const f of fs.readdirSync(opt.items).filter((x) => x.endsWith(".json"))) { const i = unwrap(readJSON(path.join(opt.items, f))); if (i?.id) { L.saveItem(blankItem(i)); n++; } }
  if (opt.bugs) for (const f of fs.readdirSync(opt.bugs).filter((x) => x.endsWith(".json"))) { const r = unwrap(readJSON(path.join(opt.bugs, f))); if (r?.key) { L.saveRow(blankRow(r)); n++; } }
  if (opt.meta) { const m = unwrap(readJSON(opt.meta)); const cur = L.meta(); L.saveMeta({ ...cur, waves: m.waves ?? cur.waves, clusters: m.clusters ?? cur.clusters, protocol: m.protocol ?? cur.protocol, excluded: m.excluded ?? cur.excluded }); n++; }
  console.log(`Imported ${n} document(s) into ${L.dir}.`);
};

// ── sync and publish: scripts, not model turns ──
// The manifest holds a hash of every document last written to the live artifact, so only changed ones are sent again.
function artifactDocs(L) {
  const m = L.meta(), pub = m.publish || {};
  const docs = [];
  for (const i of L.items()) docs.push({ target: "tracker", collection: "items", id: i.id, data: i });
  for (const r of L.rows()) docs.push({ target: pub.registerUrl ? "register" : "tracker", collection: "bugs", id: r.key, data: r });
  docs.push({ target: "tracker", collection: "meta", id: "protocol", data: { title: m.title, subtitle: m.subtitle, project: m.project, waves: m.waves, clusters: m.clusters, protocol: m.protocol, excluded: m.excluded, registerUrl: pub.registerUrl || "", updatedAt: m.updatedAt || "" } });
  if (pub.registerUrl) docs.push({ target: "register", collection: "meta", id: "register", data: { title: (m.title || "").replace(/Tracker$/i, "Register").trim() || "Bug Register", project: m.project, subtitle: m.subtitle, trackerUrl: pub.trackerUrl || "", updatedAt: m.updatedAt || "" } });
  return docs;
}
function prepareArtifact(L, out, dry) {
  const pub = L.meta().publish || {};
  if (!pub.trackerUrl) die("No live tracker: publish the page first and record its URL in meta.publish.trackerUrl (/fixit-plugin:publish).");
  const mf = path.join(L.dir, "publish-manifest.json");
  const known = fs.existsSync(mf) ? readJSON(mf).docs || {} : {};
  const changed = [], hashes = {};
  for (const d of artifactDocs(L)) {
    const key = `${d.collection}/${d.id}`, h = sha256(JSON.stringify(d.data));
    if (known[key] !== h) { changed.push({ ...d, key }); hashes[key] = h; }
  }
  const batches = [];
  for (const target of ["tracker", "register"]) {
    let cur = null, bytes = 0;
    for (const d of changed.filter((x) => x.target === target)) {
      // The document goes in its own file, so the model's ArtifactData call carries a path, not the content.
      const w = { op: "set", collection: d.collection, doc_id: d.id, file_path: path.join(out, "docs", d.collection, d.id + ".json") }, size = JSON.stringify(d.data).length;
      if (!cur || cur.writes.length >= 50 || bytes + size > 900000) { cur = { artifact: target, url: target === "register" ? pub.registerUrl : pub.trackerUrl, existing: [], writes: [] }; bytes = 0; batches.push(cur); }
      cur.writes.push(w); bytes += size;
      if (known[d.key]) cur.existing.push(d.key);
    }
  }
  if (!dry) {
    fs.mkdirSync(out, { recursive: true });
    for (const f of fs.readdirSync(out)) if (/^batch-\d+\.json$/.test(f)) fs.rmSync(path.join(out, f));
    fs.rmSync(path.join(out, "docs"), { recursive: true, force: true });
    for (const d of changed) writeJSON(path.join(out, "docs", d.collection, d.id + ".json"), d.data);
    batches.forEach((b, k) => writeText(path.join(out, `batch-${String(k + 1).padStart(3, "0")}.json`), JSON.stringify(b) + "\n"));
    writeJSON(path.join(L.dir, "publish-pending.json"), { out, docs: hashes });
  }
  return { changed: changed.length, batches: batches.length, text: `${changed.length} changed, ${batches.length} batches, ${out}` };
}
function commitArtifact(L) {
  const pf = path.join(L.dir, "publish-pending.json");
  if (!fs.existsSync(pf)) die("Nothing prepared: run sync --artifact-prepare (or publish --prepare) first.");
  const mf = path.join(L.dir, "publish-manifest.json"), pending = readJSON(pf);
  const cur = fs.existsSync(mf) ? readJSON(mf) : { docs: {} };
  writeJSON(mf, { docs: { ...cur.docs, ...pending.docs }, updatedAt: now() });
  fs.rmSync(pf);
  return Object.keys(pending.docs).length;
}
cmds.sync = ({ opt }) => {
  const L = Ledger.locate(opt).need();
  if (opt["artifact-commit"]) return console.log(`sync: manifest updated for ${commitArtifact(L)} document(s)`);
  const dry = !!opt["dry-run"];
  const mirrored = mirrorAll(L, dry).length;
  const { errors, warnings } = validate(L);
  if (!dry) renderDashboard(L, {});
  let line = `sync: ${mirrored} register row(s) ${dry ? "would be " : ""}mirrored; ${errors.length} errors, ${warnings.length} warnings${dry ? "" : "; dashboard written"}`;
  if (opt["artifact-prepare"]) {
    if (!opt.out || opt.out === true) die("--artifact-prepare needs --out DIR.");
    line += `; ${prepareArtifact(L, path.resolve(opt.out), dry).text}`;
  }
  console.log(line);
  if (errors.length) process.exitCode = 1;
};
cmds.publish = ({ opt }) => {
  const L = Ledger.locate(opt).need();
  if (!opt.prepare || !opt.out || opt.out === true) die("Usage: publish --prepare --out DIR   (after the writes succeed: sync --artifact-commit)");
  console.log(prepareArtifact(L, path.resolve(opt.out), !!opt["dry-run"]).text);
};

// ── batch: many ops, one call, all or nothing ──
const list = (v) => (Array.isArray(v) ? v.join(",") : v);
const BATCH_OPS = {
  stage: (L, o, by) => cmds.stage({ pos: [list(o.ids ?? o.id), o.stage], opt: { by, note: o.note } }),
  note: (L, o, by) => cmds.note({ pos: [o.id, o.text ?? die("note needs text")], opt: { by } }),
  "set-plan": (L, o, by) => cmds["set-plan"]({ pos: [o.id], opt: { path: o.path, summary: o.summary, risk: o.risk, pinnedBy: o.pinnedBy, dependsOn: o.dependsOn, by } }),
  cluster: (L, o, by) => cmds.cluster({ pos: [o.id], opt: { name: o.name, items: list(o.items), add: list(o.add), remove: list(o.remove) } }),
  "request-changes": (L, o, by) => cmds["request-changes"]({ pos: [o.id], opt: { note: o.note, by } }),
  "add-item": (L, o, by) => createItems(L, [o.item ?? die("add-item needs item")], by, () => {}),
  "add-row": (L, o, by) => createRows(L, [o.row ?? die("add-row needs row")], by, () => {}),
};
cmds.batch = ({ pos, opt }) => {
  const src = pos[0] || (typeof opt.file === "string" ? opt.file : "") || die("Usage: batch FILE|- [--dry-run] [--no-validate]");
  let spec;
  try { spec = JSON.parse(src === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(src, "utf8")); } catch (e) { die(`Cannot read the batch: ${e.message}`); }
  const ops = Array.isArray(spec) ? spec : spec.ops;
  if (!Array.isArray(ops) || !ops.length) die("The batch has no ops.");
  const L = Ledger.locate(opt).need();
  const before = opt["no-validate"] ? null : validate(L);
  const problems = [], counts = {};
  const log = console.log;
  L.begin();
  Ledger.active = L;
  console.log = () => {};
  try {
    ops.forEach((o, k) => {
      const tag = `op ${k + 1} (${o?.op || "?"}${o?.id ? " " + o.id : o?.ids ? " " + list(o.ids) : ""})`;
      try {
        if (!o || typeof o.op !== "string") die("no op name");
        if (o.op === "approve") die("approve is never allowed in a batch; the owner runs it alone");
        const fn = BATCH_OPS[o.op] || die(`unknown op ${o.op}`);
        fn(L, o, o.by || spec.by || "");
        counts[o.op] = (counts[o.op] || 0) + 1;
      } catch (e) { if (!(e instanceof UserError)) throw e; problems.push(`${tag}: ${e.message}`); }
    });
    let warnN = 0, warnText = [];
    if (!problems.length && before) {
      const after = validate(L), had = new Set([...before.errors, ...before.warnings]);
      const newErr = after.errors.filter((x) => !had.has(x));
      for (const x of newErr) problems.push(`validate: ${x}`);
      const newWarn = after.warnings.filter((x) => !had.has(x));
      warnN = newWarn.length; warnText = newWarn.slice(0, 3);
    }
    console.log = log;
    if (problems.length) {
      L.discard();
      die(`batch refused, nothing written (${problems.length} problem${problems.length > 1 ? "s" : ""}):\n  ${problems.slice(0, 10).join("\n  ")}${problems.length > 10 ? `\n  +${problems.length - 10} more` : ""}`);
    }
    if (opt["dry-run"]) L.discard(); else L.commit();
    console.log(`batch: ${ops.length} ops ${opt["dry-run"] ? "would apply" : "applied"} (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}); 0 errors, ${warnN} warnings`);
    for (const w of warnText) console.log(`  warn ${w}`);
  } finally { console.log = log; Ledger.active = null; if (L.buf) L.discard(); }
};

cmds.usage = ({ opt }) => {
  const usage = require("./usage.cjs");
  try { usage.main(opt, (l) => console.log(l)); }
  catch (e) { if (e instanceof usage.UsageError) die(e.message); throw e; }
};

// ───────────────────────────── main ─────────────────────────────
function main(argv) {
  const { pos, opt } = parseArgs(argv);
  const name = pos.shift() || "help";
  const fn = cmds[name];
  if (!fn) die(`Unknown command ${name}. Run: remedy help`);
  if (process.env.REMEDY_RUN_ITEM) refuseInsideRun(name, pos, opt);
  return fn({ pos, opt });
}
// A second lock behind remedy run's allowlist: a worker under remedy run has these commands and no others, on its own
// items. It matters when the owner's own settings allow more than the run's list does. REMEDY_RUN_ITEM is set by run.cjs.
const RUN_COMMANDS = new Set(["brief", "stage", "report", "done", "add-item", "add-row", "next-id", "show", "status", "help"]);
function refuseInsideRun(name, pos, opt) {
  const mine = process.env.REMEDY_RUN_ITEM.split(",");
  const no = (m) => die(`refused inside remedy run: ${m}`);
  if (!RUN_COMMANDS.has(name)) no(`remedy ${name} belongs to the owner or the lead.`);
  if (opt.dir) no("--dir; a worker uses the run's ledger.");
  if (["stage", "done"].includes(name)) {
    const other = (pos[0] || "").split(",").filter((x) => x && !mine.includes(x));
    if (other.length) no(`${other.join(", ")} is not in this run (${mine.join(", ")}).`);
  }
  if (name === "stage" && !["building", "blocked"].includes(pos[1])) no(`a worker cannot move an item to ${pos[1]}.`);
  if (name === "report" && pos[0] && !mine.includes(pos[0]) && !opt.show) no(`${pos[0]} is not in this run (${mine.join(", ")}).`);
}
module.exports = { main, Ledger, validate, STAGES, PAST_GATE, STAGE_TO_STATUS, blankItem, blankRow };
if (require.main === module) {
  const fail = (e) => { if (e instanceof UserError) { console.error("remedy: " + e.message); process.exitCode = 2; } else throw e; };
  try { Promise.resolve(main(process.argv.slice(2))).catch(fail); } catch (e) { fail(e); }
}
