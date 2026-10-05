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
const cp = require("child_process");

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
function writeJSON(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n");
  fs.renameSync(tmp, p);
}
function gitRoot(cwd) {
  try { return cp.execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return cwd; }
}

// ───────────────────────────── ledger ─────────────────────────────
class Ledger {
  constructor(dir) {
    this.dir = dir;
    this.root = path.dirname(dir);
  }
  static locate(opt) {
    const dir = opt.dir || process.env.REMEDY_DIR || path.join(gitRoot(process.cwd()), ".remedy");
    return new Ledger(path.resolve(dir));
  }
  exists() { return fs.existsSync(path.join(this.dir, "meta.json")); }
  need() { if (!this.exists()) die(`No ledger at ${this.dir}. Run: remedy init --title "<programme>"`); return this; }
  meta() { return readJSON(path.join(this.dir, "meta.json")); }
  saveMeta(m) { m.updatedAt = now(); writeJSON(path.join(this.dir, "meta.json"), m); }
  _list(sub) {
    const d = path.join(this.dir, sub);
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => readJSON(path.join(d, f)));
  }
  items() { return this._list("items").sort((a, b) => (a.order ?? 0) - (b.order ?? 0)); }
  rows() { return this._list("register").sort((a, b) => (a.order ?? 0) - (b.order ?? 0)); }
  itemPath(id) { return path.join(this.dir, "items", id + ".json"); }
  rowPath(k) { return path.join(this.dir, "register", k + ".json"); }
  item(id) { const p = this.itemPath(id); if (!fs.existsSync(p)) die(`No item ${id}.`); return readJSON(p); }
  row(k) { const p = this.rowPath(k); return fs.existsSync(p) ? readJSON(p) : null; }
  saveItem(i) { writeJSON(this.itemPath(i.id), i); }
  saveRow(r) { writeJSON(this.rowPath(r.key), r); }
  createItem(i) { if (fs.existsSync(this.itemPath(i.id))) die(`Item ${i.id} already exists (create-only; pick another id with next-id).`); this.saveItem(i); }
  createRow(r) { if (fs.existsSync(this.rowPath(r.key))) die(`Register row ${r.key} already exists.`); this.saveRow(r); }
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
  }
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
  status [--json]                     counts by stage, items waiting for approval, approved-not-built
  next-id PREFIX [--count N]          next free ids (items, register rows and reserved ranges)
  reserve PREFIX --from N --to M --owner S   reserve an id range for a parallel session
  add-item --json FILE|-              create-only; fields as in schemas/item.schema.json
  add-row  --json FILE|-              create-only register row; fields as in schemas/register.schema.json
  show ID                             print an item (and its register row)
  cluster ID --name NAME [--items A,B] [--add A] [--remove A]
  set-plan ID --path P --summary S [--by WHO]   record the plan; moves to plan_review; withdraws a prior approval
  stage ID STAGE [--note N] [--by WHO]          move along the lifecycle (gate enforced; use approve for 'approved')
  approve ID --by WHO [--note N]                OWNER ONLY: record plan approval
  request-changes ID --note N [--by WHO]        send a plan back to planning
  note ID TEXT                         set the item note
  sync-register [--dry-run]            mirror tracker stages onto linked register rows
  import-findings FILE [--prefix SEC] [--wave W0] [--found-by TEXT] [--workstream TEXT] [--dry-run]
                                       intake a security-audit findings.json (confirmed → register + item; needs_validation → item)
  import-campaign FILE [--prefix P] [--wave W] [--found-by TEXT] [--dry-run]
                                       intake a test-campaign campaign-findings.json (confirmed → register + item; lead → item)
  scan [--root DIR]                  list pinned-defect markers (it.fails, .todo, test.fixme, KNOWN_ ratchets, BUG:) as JSON
  validate                             schema + gate + cross-reference checks (exit 1 on errors)
  render [--out FILE]                  self-contained read-only dashboard (tracker + register)
  export-artifact --out DIR            payload files for a claude.ai artifact backend (items/, bugs/, meta-protocol.json)
  import-artifact [--items DIR] [--bugs DIR] [--meta FILE]   refresh the ledger from ArtifactData out_dir snapshots

Global: --dir PATH (default <git root>/.remedy, or REMEDY_DIR)`);
};

cmds.init = ({ opt }) => {
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
  fs.writeFileSync(path.join(L.dir, "README.md"), `# ${m.title}\n\nThis directory is a fixit-plugin ledger. Edit it with the remedy CLI or the /fixit-plugin commands, not by hand.\nPlans live in \`${m.planDir}/\`. Run \`node <plugin>/skills/remedy/scripts/remedy.cjs status\`.\n`);
  fs.mkdirSync(path.join(L.root, m.planDir), { recursive: true });
  console.log(`Initialised ${path.relative(process.cwd(), L.dir) || L.dir} (plans in ${m.planDir}/).`);
};

cmds.status = ({ opt }) => {
  const L = Ledger.locate(opt).need();
  const m = L.meta(), items = L.items(), rows = L.rows();
  const by = Object.fromEntries(STAGES.map((s) => [s, items.filter((i) => i.stage === s)]));
  const s = {
    title: m.title, items: items.length, registerRows: rows.length,
    byStage: Object.fromEntries(STAGES.map((k) => [k, by[k].length])),
    waitingForApproval: by.plan_review.map((i) => i.id),
    approvedNotBuilt: by.approved.map((i) => i.id),
    building: by.building.map((i) => i.id),
    openCritical: items.filter((i) => i.severity === "critical" && !["done", "wont_do"].includes(i.stage)).map((i) => i.id),
    clusters: (m.clusters || []).map((c) => ({ id: c.id, name: c.name, items: c.items.length, planned: c.items.filter((id) => { const i = items.find((x) => x.id === id); return i && i.plan?.path; }).length, approved: c.items.filter((id) => items.find((x) => x.id === id)?.plan?.approvedAt).length, done: c.items.filter((id) => items.find((x) => x.id === id)?.stage === "done").length })),
    unclusteredBacklog: items.filter((i) => !i.cluster && i.stage === "backlog").map((i) => i.id),
    registerOpen: rows.filter((r) => ["open", "in_progress"].includes(r.status)).length,
  };
  if (opt.json) return console.log(JSON.stringify(s, null, 2));
  console.log(`${s.title} — ${s.items} items, ${s.registerRows} register rows (${s.registerOpen} unresolved)`);
  console.log(STAGES.map((k) => `${k}:${s.byStage[k]}`).join("  "));
  if (s.openCritical.length) console.log(`Open critical: ${s.openCritical.join(", ")}`);
  if (s.waitingForApproval.length) console.log(`Waiting for owner approval: ${s.waitingForApproval.join(", ")}`);
  if (s.approvedNotBuilt.length) console.log(`Approved, not yet built: ${s.approvedNotBuilt.join(", ")}`);
  if (s.building.length) console.log(`Building: ${s.building.join(", ")}`);
  for (const c of s.clusters) console.log(`  ${c.id.padEnd(16)} ${c.name} — planned ${c.planned}/${c.items}, approved ${c.approved}/${c.items}, done ${c.done}/${c.items}`);
  if (s.unclusteredBacklog.length) console.log(`Unclustered backlog: ${s.unclusteredBacklog.join(", ")}`);
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

cmds["add-item"] = ({ opt }) => {
  const L = Ledger.locate(opt).need();
  const list = [].concat(readInputJSON(opt));
  for (const o of list) {
    if (!o.id || !ID_RE.test(o.id)) die(`Bad or missing id ${o.id}`);
    if (o.stage && (PAST_GATE.has(o.stage) || o.stage === "approved")) die(`${o.id}: new items cannot start past the gate.`);
    const i = blankItem({ ...o, order: o.order ?? L.nextOrder("item") });
    addHistory(i, { action: "Created", stage: i.stage, note: o.createdNote || "" }, opt.by);
    L.createItem(i);
    if (i.cluster) addToCluster(L, i.cluster, i.id);
    console.log(`Created ${i.id}.`);
  }
};

cmds["add-row"] = ({ opt }) => {
  const L = Ledger.locate(opt).need();
  for (const o of [].concat(readInputJSON(opt))) {
    if (!o.key || !ID_RE.test(o.key)) die(`Bad or missing key ${o.key}`);
    const r = blankRow({ ...o, order: o.order ?? L.nextOrder("row") });
    addHistory(r, { status: r.status, note: "Added" }, opt.by);
    L.createRow(r);
    console.log(`Added register row ${r.key}.`);
  }
};

cmds.show = ({ pos, opt }) => {
  const L = Ledger.locate(opt).need();
  const i = L.item(pos[0]);
  console.log(JSON.stringify({ item: i, register: i.registerKey ? L.row(i.registerKey) : null }, null, 2));
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
    const p = L.itemPath(id); if (!fs.existsSync(p)) continue;
    const i = readJSON(p);
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
  if (!opt.path || !opt.summary) die("Usage: set-plan ID --path P --summary S");
  if (!fs.existsSync(path.join(L.root, opt.path))) die(`Plan file ${opt.path} does not exist. Write it first.`);
  if (PAST_GATE.has(i.stage)) die(`${i.id} is ${i.stage}; changing its plan now needs a new item or an explicit re-plan (stage it back first).`);
  const wasApproved = !!i.plan?.approvedAt;
  const changed = opt.path !== i.plan?.path || opt.summary !== i.plan?.summary;
  i.plan = { ...i.plan, path: opt.path, summary: opt.summary };
  if (wasApproved && changed) { i.plan.approvedAt = ""; i.plan.approvedBy = ""; }
  i.stage = "plan_review";
  addHistory(i, { action: wasApproved && changed ? "Plan revised (approval withdrawn)" : "Plan written", stage: "plan_review", note: `Plan: ${opt.path}` }, opt.by);
  L.saveItem(i);
  console.log(`${i.id} → plan_review${wasApproved && changed ? " (previous approval withdrawn — owner must approve again)" : ""}.`);
};

cmds.stage = ({ pos, opt }) => {
  const L = Ledger.locate(opt).need();
  const i = L.item(pos[0]);
  const st = pos[1];
  if (!STAGES.includes(st)) die(`Unknown stage ${st}. One of: ${STAGES.join(", ")}`);
  if (st === "approved") die("Use `approve` to record an approval (owner only).");
  if (PAST_GATE.has(st) && !i.plan?.approvedAt) die(`${i.id} can't move to ${st}: its plan has not been approved. Gate closed.`);
  if (st === "plan_review" && !i.plan?.path) die(`${i.id} has no plan; use set-plan.`);
  if (["backlog", "planning"].includes(st) && i.plan?.approvedAt) { i.plan.approvedAt = ""; i.plan.approvedBy = ""; }
  const from = i.stage;
  i.stage = st;
  if (opt.note) i.note = opt.note;
  addHistory(i, { action: `Stage ${from} → ${st}`, stage: st, note: opt.note || "" }, opt.by);
  L.saveItem(i);
  if (i.registerKey && opt["no-sync"] !== true) syncOne(L, i);
  console.log(`${i.id}: ${from} → ${st}.`);
};

cmds.approve = ({ pos, opt }) => {
  const L = Ledger.locate(opt).need();
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
cmds["sync-register"] = ({ opt }) => {
  const L = Ledger.locate(opt).need();
  const out = [];
  for (const i of L.items()) {
    if (!i.registerKey) continue;
    const r = L.row(i.registerKey); if (!r) continue;
    const want = STAGE_TO_STATUS[i.stage];
    if (i.stage === "blocked" || r.status === want) continue;
    if (opt["dry-run"]) out.push({ key: r.key, from: r.status, to: want });
    else out.push(syncOne(L, i));
  }
  console.log(out.length ? out.map((c) => `${c.key}: ${c.from} → ${c.to}`).join("\n") : "Register already in step.");
};

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
  for (const w of warnings) console.log("warn  " + w);
  for (const e of errors) console.log("ERROR " + e);
  console.log(`${errors.length} error(s), ${warnings.length} warning(s).`);
  if (errors.length) process.exitCode = 1;
};

// ── dashboard ──
cmds.render = ({ opt }) => {
  const L = Ledger.locate(opt).need();
  const tpl = fs.readFileSync(path.join(__dirname, "..", "assets", "tracker.html"), "utf8");
  const data = { meta: L.meta(), items: L.items(), bugs: L.rows(), generatedAt: now(), cli: "node " + (path.relative(L.root, __filename).startsWith("..") ? __filename : path.relative(L.root, __filename)) };
  const inject = `<script>window.__REMEDY_DATA__=${JSON.stringify(data).replace(/</g, "\\u003c")};</script>`;
  const html = tpl.replace("<!--REMEDY_DATA-->", inject);
  const out = path.resolve(opt.out || path.join(L.dir, "dashboard.html"));
  fs.writeFileSync(out, html);
  console.log(`Wrote ${out}`);
};

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
  const unwrap = (o) => (o && o.data && (o.id || o.version) ? o.data : o);
  let n = 0;
  if (opt.items) for (const f of fs.readdirSync(opt.items).filter((x) => x.endsWith(".json"))) { const i = unwrap(readJSON(path.join(opt.items, f))); if (i?.id) { L.saveItem(blankItem(i)); n++; } }
  if (opt.bugs) for (const f of fs.readdirSync(opt.bugs).filter((x) => x.endsWith(".json"))) { const r = unwrap(readJSON(path.join(opt.bugs, f))); if (r?.key) { L.saveRow(blankRow(r)); n++; } }
  if (opt.meta) { const m = unwrap(readJSON(opt.meta)); const cur = L.meta(); L.saveMeta({ ...cur, waves: m.waves ?? cur.waves, clusters: m.clusters ?? cur.clusters, protocol: m.protocol ?? cur.protocol, excluded: m.excluded ?? cur.excluded }); n++; }
  console.log(`Imported ${n} document(s) into ${L.dir}.`);
};

// ───────────────────────────── main ─────────────────────────────
function main(argv) {
  const { pos, opt } = parseArgs(argv);
  const name = pos.shift() || "help";
  const fn = cmds[name];
  if (!fn) die(`Unknown command ${name}. Run: remedy help`);
  return fn({ pos, opt });
}
module.exports = { main, Ledger, validate, STAGES, PAST_GATE, STAGE_TO_STATUS, blankItem, blankRow };
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (e) { if (e instanceof UserError) { console.error("remedy: " + e.message); process.exitCode = 2; } else throw e; }
}
