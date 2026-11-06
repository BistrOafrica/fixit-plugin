/* remedy usage: where the tokens went, read from Claude Code transcripts.
 *
 * Reads <projects>/<project dir>/**.jsonl (default ~/.claude/projects). It never touches the ledger.
 * Ported from analysis/usage*.py. One record per message.id in a file, the last usage wins.
 * The transcript format is not a documented contract (V8): lines that do not look right fail clearly.
 *
 * Weighted cost = cache read * 0.1 + cache write * 1.25 + output * 5 + input, in input-token units.
 * These ratios are assumed. Per-model prices apply only with --price.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const W = { cr: 0.1, cc: 1.25, out: 5, i: 1 };
const KINDS = [
  ["fixit", /(^|[\s;&|/])fixit(\.cjs)?["']?\s+(test|logs|show|wait|clean)\b/],
  ["ledger", /remedy\.cjs|\bremedy\b/],
  ["test", /vitest|playwright|go test|flutter test|make (test|campaign)|pnpm (run )?test|npm (run )?test|phpunit|\bpest\b|artisan test|jest|\bk6\b|cypress/],
  ["logs", /docker (compose )?logs|compose .*logs|journalctl|kubectl logs|dev-logs|tail -[fFn]|\.log\b|\bgrep\b.*\b(log|Log)\b/],
  ["build/deploy", /make dev|go build|go vet|docker (build|restart|compose)|compose (up|build)|pnpm (build|install)|npm (run build|install)|flutter (build|pub)|\btsc\b|gofmt|composer /],
  ["git", /^\s*(cd [^;&]+&&\s*)?git\b/],
  ["read code", /^\s*(cd [^;&]+&&\s*)?(sed -n|cat |head |tail |grep |rg |ls |find |wc |awk )/],
  ["db/curl", /psql|curl |redis-cli|mysql|docker exec/],
];
const kindOf = (c) => { for (const [n, re] of KINDS) if (re.test(c)) return n; return "other"; };
const ITEM_CMD = /\bremedy(?:\.cjs)?\s+(brief|stage|done)\s+((?:[A-Za-z][A-Za-z0-9]*-\d+,?)+)/;
const ITEM_ID = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const BANDS = [["<100k", 100e3], ["100-200k", 200e3], ["200-400k", 400e3], ["400-700k", 700e3], ["700k+", Infinity]];
const CEILING = { main: 100e3, worker: 120e3 };
const OUTPUT_CAP = 10000;

class UsageError extends Error {}
const fail = (m) => { throw new UsageError(m); };
const aliasOf = (m) => (/opus/.test(m) ? "opus" : /sonnet/.test(m) ? "sonnet" : /haiku/.test(m) ? "haiku" : "other");
// Real models start with "claude-". "<synthetic>" is a placeholder Claude Code writes with zero usage; those turns
// are not API calls and are skipped (counted in the footer). A missing model is labelled "(none)".
const cleanModel = (m) => (typeof m !== "string" || !m ? "(none)" : m.replace(/\[[^\]]*\]$/, ""));
const toolLabel = (n) => (typeof n !== "string" ? "?" : n.startsWith("mcp__") ? "mcp" : n);
const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);

// Length of the value as Python's json.dumps would print it (", " and ": " separators, non-ASCII escaped as \uXXXX),
// so that result sizes stay comparable with the baseline figures made by analysis/usage*.py.
function jsonLen(v) {
  if (v === null || v === undefined) return 4;
  if (typeof v === "string") { let n = JSON.stringify(v).length; for (let i = 0; i < v.length; i++) if (v.charCodeAt(i) > 127) n += 5; return n; }
  if (typeof v !== "object") return JSON.stringify(v).length;
  if (Array.isArray(v)) { let n = 2 + 2 * Math.max(v.length - 1, 0); for (const x of v) n += jsonLen(x); return n; }
  const ks = Object.keys(v); let n = 2 + 2 * Math.max(ks.length - 1, 0);
  for (const key of ks) n += jsonLen(key) + 2 + jsonLen(v[key]);
  return n;
}

function listFiles(dir) {
  const out = [];
  (function walk(d, proj) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, proj || e.name);
      else if (e.isFile() && e.name.endsWith(".jsonl") && proj) out.push({ file: p, proj });
    }
  })(dir, "");
  return out;
}

// Parse one transcript into turns (deduplicated by message.id) plus tool-result statistics.
function readTranscript(file, since, until) {
  const text = fs.readFileSync(file, "utf8");
  const sub = file.includes(`${path.sep}subagents${path.sep}`) || path.basename(file).startsWith("agent-");
  const turns = new Map(), res = { byTool: {}, bash: [] }, ids = new Map(), compactions = [];
  const agentCalls = [];
  let cur = [], bad = 0, lines = 0, lineNo = 0;
  for (const line of text.split("\n")) {
    lineNo++;
    if (!line) continue;
    lines++;
    let o;
    try { o = JSON.parse(line); } catch { bad++; continue; }
    if (!o || typeof o !== "object") { bad++; continue; }
    const m = o.message && typeof o.message === "object" ? o.message : {};
    const ts = typeof o.timestamp === "string" ? o.timestamp : null;
    if (o.subtype === "compact_boundary") {
      const pre = o.compactMetadata && o.compactMetadata.preTokens;
      if (typeof pre === "number" && (!ts || (ts.slice(0, 10) >= since && (!until || ts.slice(0, 10) <= until)))) compactions.push(pre);
    }
    if (o.type === "assistant" && m.usage !== undefined && m.usage !== null) {
      const u = m.usage;
      if (typeof u !== "object" || Array.isArray(u) || !["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].some((k) => typeof u[k] === "number"))
        fail(`unknown transcript shape in ${file} line ${lineNo}: assistant message.usage has none of input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens (format changed? V8)`);
      if (!u || !ts) continue;
      const day = ts.slice(0, 10);
      if (day < since || (until && day > until)) continue;
      if (m.model === "<synthetic>") { turns.synthetic = (turns.synthetic || 0) + 1; continue; }
      const k = m.id || ts;
      let t = turns.get(k);
      if (!t) { t = { ts, tools: [], cats: [], items: cur.slice(), agentCalls: [] }; turns.set(k, t); }
      t.u = u; t.model = cleanModel(m.model);
      if (Array.isArray(m.content)) for (const b of m.content) {
        if (!b || b.type !== "tool_use") continue;
        const name = b.name;
        ids.set(b.id, name === "Bash" ? "Bash" : toolLabel(name));
        t.tools.push(toolLabel(name));
        const inp = b.input && typeof b.input === "object" ? b.input : {};
        if (name === "Bash") {
          const cmd = typeof inp.command === "string" ? inp.command : "";
          t.cats.push(kindOf(cmd));
          const mm = ITEM_CMD.exec(cmd);
          if (mm) { cur = mm[2].split(",").filter((x) => ITEM_ID.test(x)).map((x) => x.toUpperCase()); t.items = cur.slice(); }
          if (cmd.includes(".fixit/out/")) t.fixitRead = true;
        } else if (name === "Read" && typeof inp.file_path === "string" && inp.file_path.includes(".fixit/out/")) t.fixitRead = true;
        if ((name === "Agent" || name === "Task") && b.id) agentCalls.push({ id: b.id, model: typeof inp.model === "string" ? inp.model : null, type: typeof inp.subagent_type === "string" ? inp.subagent_type : null });
        t.bashIds = t.bashIds || [];
        if (name === "Bash") t.bashIds.push(b.id);
      }
    } else if (o.type === "user" && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b || b.type !== "tool_result" || !ids.has(b.tool_use_id)) continue;
        const n = jsonLen(b.content === undefined ? "" : b.content), name = ids.get(b.tool_use_id);
        const r = res.byTool[name] || (res.byTool[name] = { n: 0, chars: 0 });
        r.n++; r.chars += n;
        if (name === "Bash") res.bash.push(n);
        if (typeof o.toolUseResult === "object" && o.toolUseResult && o.toolUseResult.agentId)
          agentCalls.push({ id: b.tool_use_id, agentId: o.toolUseResult.agentId, resolved: typeof o.toolUseResult.resolvedModel === "string" ? o.toolUseResult.resolvedModel : null });
      }
    }
  }
  // A torn last line is normal in a live file; a mostly unparseable file is not a transcript.
  if (lines >= 10 && bad > lines / 2) fail(`unknown transcript shape in ${file}: ${bad} of ${lines} lines are not JSON`);
  const synthetic = turns.synthetic || 0; turns.delete("synthetic");
  return { sub, turns: [...turns.values()], synthetic, res, compactions, agentCalls };
}

function agentMeta(file) {
  try { return JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8")); } catch { return null; }
}

function collect(opt) {
  const dir = opt.projects || path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(dir)) fail(`no transcripts directory at ${dir}`);
  const since = opt.since === true || !opt.since ? "1970-01-01" : String(opt.since);
  const until = opt.until === true || !opt.until ? "" : String(opt.until);
  for (const [k, v] of [["--since", since], ["--until", until]]) if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) fail(`${k} needs a date as YYYY-MM-DD, got "${v}"`);
  if (until && until < since) fail("--until is before --since");
  const minM = since === "1970-01-01" ? 0 : new Date(+since.slice(0, 4), +since.slice(5, 7) - 1, +since.slice(8, 10)).getTime();
  const only = typeof opt.project === "string" ? opt.project : "";
  const excl = typeof opt.exclude === "string" ? opt.exclude.split(",").filter(Boolean) : [];
  const files = listFiles(dir).filter((f) => (!only || f.proj.includes(only)) && !excl.some((x) => f.proj.includes(x)) && fs.statSync(f.file).mtimeMs >= minM);
  const turns = [], tool = {}, bash = [], compactions = [], projects = new Set();
  let synthetic = 0, scanned = 0;
  const metaByTool = new Map();               // Agent tool_use id -> {requested model, subagent type}
  const agentOf = new Map();                  // agentId -> {resolved, toolUseId}
  const perFile = [];
  for (const f of files) {
    const r = readTranscript(f.file, since, until);
    scanned++;
    synthetic += r.synthetic;
    for (const c of r.compactions) compactions.push(c);
    for (const [n, v] of Object.entries(r.res.byTool)) { const x = tool[n] || (tool[n] = { n: 0, chars: 0 }); x.n += v.n; x.chars += v.chars; }
    for (const b of r.res.bash) bash.push(b);
    const sess = f.file.slice(path.join(dir, f.proj).length + 1).split(path.sep)[0].replace(/\.jsonl$/, "");
    const sa = r.sub ? path.basename(f.file).replace(/^agent-/, "").replace(/\.jsonl$/, "") : null;
    const meta = r.sub ? agentMeta(f.file) : null;
    for (const c of r.agentCalls) {
      if (c.agentId) agentOf.set(c.agentId, { resolved: c.resolved, toolUseId: c.id });
      else metaByTool.set(c.id, { requested: c.model, type: c.type });
    }
    for (const t of r.turns) {
      t.proj = f.proj; t.sub = r.sub; t.sess = sess.slice(0, 8); t.agentId = sa; t.agentType = meta && meta.agentType || null; t.toolUseId = meta && meta.toolUseId || null;
      turns.push(t);
    }
    if (r.turns.length) projects.add(f.proj);
    perFile.push(f.file);
  }
  if (scanned && !turns.length && !synthetic) fail(`read ${scanned} transcript file(s) under ${dir} but found no assistant turns with usage in the window; if the window is right, the transcript format may have changed (V8)`);
  return { turns, tool, bash, compactions, projects: [...projects].sort(), synthetic, scanned, since, until, excl, metaByTool, agentOf, dir };
}

function parsePrice(s) {
  const p = { opus: 1, sonnet: 1, haiku: 1, other: 1 };
  if (!s || s === true) return null;
  for (const part of String(s).split(",")) {
    const [k, v] = part.split("=");
    if (!["opus", "sonnet", "haiku"].includes(k) || !(+v > 0)) fail(`--price needs opus=1,sonnet=R,haiku=R with positive numbers, got "${part}"`);
    p[k] = +v;
  }
  return p;
}

function analyse(C, opt) {
  const price = parsePrice(opt.price);
  const T = C.turns;
  // Order within a file is kept: turns arrive grouped by file in first-appearance order.
  const per = new Map();
  let prevKey = null, prev = null;
  for (const t of T) {
    const u = t.u;
    t.i = num(u.input_tokens); t.cr = num(u.cache_read_input_tokens); t.cc = num(u.cache_creation_input_tokens); t.out = num(u.output_tokens);
    t.size = t.i + t.cr + t.cc;
    t.w = t.cr * W.cr + t.cc * W.cc + t.out * W.out + t.i * W.i;
    t.wp = t.w * (price ? price[aliasOf(t.model)] : 1);
    t.date = t.ts.slice(0, 10);
    const key = t.proj + "|" + t.sess + "|" + (t.agentId || "");
    const time = Date.parse(t.ts);
    if (key !== prevKey) { prev = null; prevKey = key; }
    t.cold = t.cc > 0.5 * t.size && t.size > 20000;
    if (t.cold) {
      const gap = prev === null ? null : (time - prev) / 1000;
      t.coldWhy = gap === null ? "first turn" : gap > 3600 ? "idle over 1h" : gap > 300 ? "idle 5m-1h" : "mid-run";
    }
    prev = time;
  }
  const sum = (arr, f) => arr.reduce((a, t) => a + f(t), 0);
  const totalW = sum(T, (t) => t.wp) || 1;
  const grp = (keyFn) => {
    const g = new Map();
    for (const t of T) {
      const ks = keyFn(t); const list = Array.isArray(ks) ? ks : [ks];
      for (const k of list) {
        let x = g.get(k); if (!x) g.set(k, (x = { turns: 0, ctxSum: 0, peak: 0, cold: 0, w: 0 }));
        const f = 1 / list.length;
        x.turns += f; x.ctxSum += t.size * f; x.peak = Math.max(x.peak, t.size); x.cold += t.cold ? f : 0; x.w += t.wp * f;
      }
    }
    return [...g.entries()].map(([k, x]) => ({ group: k, turns: round(x.turns, 1), avgCtx: Math.round(x.ctxSum / Math.max(x.turns, 1e-9)), peakCtx: x.peak, coldWrites: round(x.cold, 1), weighted: Math.round(x.w), share: round((x.w / totalW) * 100, 2) })).sort((a, b) => b.weighted - a.weighted);
  };
  const tokens = { cr: 0, cc: 0, out: 0, i: 0 };
  for (const t of T) { tokens.cr += t.cr; tokens.cc += t.cc; tokens.out += t.out; tokens.i += t.i; }
  const unp = { cr: tokens.cr * W.cr, cc: tokens.cc * W.cc, out: tokens.out * W.out, i: tokens.i * W.i };
  const unpTotal = Object.values(unp).reduce((a, b) => a + b, 0) || 1;
  const mainT = T.filter((t) => !t.sub), subT = T.filter((t) => t.sub);
  const bands = BANDS.map(([name, hi], idx) => {
    const lo = idx ? BANDS[idx - 1][1] : 0, sel = T.filter((t) => t.size >= lo && t.size < hi);
    return { band: name, turns: sel.length, share: round((sum(sel, (t) => t.wp) / totalW) * 100, 2) };
  });
  // Per action: a turn's cost is split over the distinct tools it called (usage3.py).
  const act = new Map();
  for (const t of T) {
    const names = [...new Set(t.tools)]; if (!names.length) names.push("(text only)");
    for (const n of names) { const x = act.get(n) || { turns: 0, w: 0 }; x.turns++; x.w += t.wp / names.length; act.set(n, x); }
  }
  const byAction = [...act.entries()].map(([k, x]) => ({ group: k, turns: x.turns, avgCtxPlaceholder: undefined, weighted: Math.round(x.w), share: round((x.w / totalW) * 100, 2) })).map(({ avgCtxPlaceholder, ...r }) => r).sort((a, b) => b.weighted - a.weighted);
  // Per Bash kind (usage4.py): the turn's cost is split over the distinct kinds of its Bash calls.
  const kd = new Map();
  const addKind = (c, t, part) => {
    const x = kd.get(c) || { turns: 0, ctxSum: 0, peak: 0, cold: 0, w: 0 };
    x.turns++; x.ctxSum += t.size; x.peak = Math.max(x.peak, t.size); x.cold += t.cold ? 1 : 0; x.w += t.wp * part;
    kd.set(c, x);
  };
  for (const t of T) {
    const cs = [...new Set(t.cats)];
    for (const c of cs) addKind(c, t, 1 / cs.length);
    if (!cs.length) addKind("(no bash call)", t, 1);
  }
  const kindRow = ([k, x]) => ({ group: k, turns: x.turns, avgCtx: Math.round(x.ctxSum / x.turns), peakCtx: x.peak, coldWrites: x.cold, weighted: Math.round(x.w), share: round((x.w / totalW) * 100, 2) });
  const nonBash = kd.get("(no bash call)");
  kd.delete("(no bash call)");
  const byKind = [...kd.entries()].map(kindRow).sort((a, b) => b.weighted - a.weighted);
  if (nonBash) byKind.push(kindRow(["(no bash call)", nonBash]));
  const cold = {};
  for (const t of T) if (t.cold) { const x = cold[t.coldWhy] || (cold[t.coldWhy] = { count: 0, weighted: 0, ctxSum: 0 }); x.count++; x.weighted += t.cc * W.cc * (price ? price[aliasOf(t.model)] : 1); x.ctxSum += t.size; }
  for (const x of Object.values(cold)) { x.share = round((x.weighted / totalW) * 100, 2); x.avgCtx = Math.round(x.ctxSum / x.count); x.weighted = Math.round(x.weighted); delete x.ctxSum; }
  const byDay = {};
  for (const t of T) byDay[t.date] = (byDay[t.date] || 0) + t.wp;
  for (const k of Object.keys(byDay)) byDay[k] = Math.round(byDay[k]);
  const bigBash = C.bash.filter((n) => n > 10000).length;
  const comp = C.compactions;
  const waste = wasteOf(C, T, totalW);
  const A = {
    window: { since: C.since === "1970-01-01" ? null : C.since, until: C.until || null },
    excludedProjects: C.excl, projectsRead: C.projects.length,
    weighting: { cacheRead: W.cr, cacheWrite: W.cc, output: W.out, input: W.i, assumed: true, priced: price ? Object.fromEntries(["opus", "sonnet", "haiku"].map((k) => [k, price[k]])) : null },
    turns: { total: T.length, main: mainT.length, subagent: subT.length, syntheticSkipped: C.synthetic },
    tokens, weightedTotal: Math.round(totalW),
    tokenShares: Object.fromEntries(Object.entries(unp).map(([k, v]) => [{ cr: "cacheRead", cc: "cacheWrite", out: "output", i: "input" }[k], round((v / unpTotal) * 100, 2)])),
    mainShare: round((sum(mainT, (t) => t.wp) / totalW) * 100, 2), subagentShare: round((sum(subT, (t) => t.wp) / totalW) * 100, 2),
    context: { avg: T.length ? Math.round(sum(T, (t) => t.size) / T.length) : 0, peak: T.reduce((a, t) => Math.max(a, t.size), 0), mainAvg: mainT.length ? Math.round(sum(mainT, (t) => t.size) / mainT.length) : 0, mainPeak: mainT.reduce((a, t) => Math.max(a, t.size), 0), subAvg: subT.length ? Math.round(sum(subT, (t) => t.size) / subT.length) : 0, subPeak: subT.reduce((a, t) => Math.max(a, t.size), 0) },
    compactions: { count: comp.length, avgPreTokens: comp.length ? Math.round(comp.reduce((a, b) => a + b, 0) / comp.length) : 0, maxPreTokens: comp.reduce((a, b) => Math.max(a, b), 0) },
    coldWrites: { count: T.filter((t) => t.cold).length, byReason: cold },
    bands, byAction, byKind,
    toolResults: { byTool: C.tool, bashResults: C.bash.length, bashOver10k: bigBash, bashLargest: C.bash.reduce((a, b) => Math.max(a, b), 0) },
    byModel: grp((t) => t.model), byProject: grp((t) => t.proj), byDay,
    waste,
  };
  const by = opt.by;
  if (by) {
    const fn = { session: (t) => `${t.proj.slice(-24)}:${t.sess}`, agent: (t) => (t.sub ? t.agentType || "(subagent, no meta)" : "(main)"), item: (t) => (t.items.length ? t.items : "(no item)"), kind: null, model: (t) => t.model }[by];
    if (by === "kind") A.groups = { by, rows: byKind };
    else if (!fn) fail(`--by takes session, agent, item, kind or model, not "${by}"`);
    else A.groups = { by, rows: grp(fn) };
  }
  return A;
}

// Waste signals. The requested-versus-actual model check is limited: see modelCheck().
function wasteOf(C, T, totalW) {
  const over = (sel) => ({ turns: sel.length, weighted: Math.round(sel.reduce((a, t) => a + t.wp, 0)), share: round((sel.reduce((a, t) => a + t.wp, 0) / totalW) * 100, 2) });
  const idle = (why) => T.filter((t) => t.coldWhy === why);
  const fx = T.filter((t) => t.fixitRead);
  return {
    overCeilingMain: { ceiling: CEILING.main, ...over(T.filter((t) => !t.sub && t.size > CEILING.main)) },
    overCeilingWorker: { ceiling: CEILING.worker, ...over(T.filter((t) => t.sub && t.size > CEILING.worker)) },
    returnAfterIdleOver1h: over(idle("idle over 1h")),
    returnAfterIdle5mTo1h: over(idle("idle 5m-1h")),
    bashOutputOverCap: { cap: OUTPUT_CAP, results: C.bash.filter((n) => n > OUTPUT_CAP).length, of: C.bash.length },
    fixitOutReads: { turns: fx.length },
    modelCheck: modelCheck(C, T),
  };
}

// What transcripts record: the Agent tool_use input may carry `model` (an alias, only when the caller set it) and
// `subagent_type`; the tool result carries `resolvedModel`; each subagent transcript's turns carry the actual model.
// A model set in an agent definition's frontmatter or a skill is NOT recorded, so for those calls there is nothing to compare.
function modelCheck(C, T) {
  const actual = new Map();
  for (const t of T) if (t.sub && t.toolUseId) { const m = actual.get(t.toolUseId) || new Map(); m.set(t.model, (m.get(t.model) || 0) + 1); actual.set(t.toolUseId, m); }
  const r = { agentCalls: C.metaByTool.size, withRequestedModel: 0, comparable: 0, mismatches: 0, noRequestRecorded: 0, unlinked: 0, resolvedDiffersFromActual: 0 };
  for (const [id, c] of C.metaByTool) {
    const act = actual.get(id);
    if (!c.requested) { r.noRequestRecorded++; }
    else r.withRequestedModel++;
    if (!act) { if (c.requested) r.unlinked++; continue; }
    if (c.requested) {
      r.comparable++;
      if (![...act.keys()].every((m) => aliasOf(m) === aliasOf(c.requested))) r.mismatches++;
    }
  }
  for (const [, a] of C.agentOf) {
    const act = actual.get(a.toolUseId);
    if (act && a.resolved && ![...act.keys()].every((m) => aliasOf(m) === aliasOf(a.resolved))) r.resolvedDiffersFromActual++;
  }
  return r;
}

const round = (v, d) => { const p = 10 ** d; return Math.round(v * p) / p; };
const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(Math.round(n)));
const pad = (s, n) => String(s).slice(0, n).padEnd(n);

function render(A, opt) {
  const L = [];
  const w = A.window;
  L.push(`remedy usage ${w.since || "start"}..${w.until || "now"}: ${A.projectsRead} projects${A.excludedProjects.length ? ` (excluded: ${A.excludedProjects.join(",")})` : ""}, ${A.turns.total} turns (main ${A.turns.main}, subagent ${A.turns.subagent})${A.turns.syntheticSkipped ? `, ${A.turns.syntheticSkipped} synthetic skipped` : ""}`);
  L.push(`weighted ${k(A.weightedTotal)} (assumed: read ${A.weighting.cacheRead}, write ${A.weighting.cacheWrite}, output ${A.weighting.output}, input ${A.weighting.input}; ${A.weighting.priced ? "priced " + Object.entries(A.weighting.priced).map(([a, b]) => a + "=" + b).join(",") : "unpriced: models weigh the same, so no routing saving shows"})`);
  const ledger = recordedCost(opt);
  if (ledger) L.push(ledger);
  if (opt.waste) {
    const x = A.waste, row = (n, o) => `  ${pad(n, 30)} ${String(o.turns).padStart(6)} turns  ${String(o.share).padStart(5)}%`;
    L.push("waste (turns beyond the ceilings and avoidable cold starts):");
    L.push(row(`context over ${k(x.overCeilingMain.ceiling)}, main`, x.overCeilingMain));
    L.push(row(`context over ${k(x.overCeilingWorker.ceiling)}, worker`, x.overCeilingWorker));
    L.push(row("return after idle over 1h", x.returnAfterIdleOver1h));
    L.push(row("return after idle 5m-1h", x.returnAfterIdle5mTo1h));
    L.push(`  bash results over ${x.bashOutputOverCap.cap} chars: ${x.bashOutputOverCap.results} of ${x.bashOutputOverCap.of}`);
    L.push(`  turns reading .fixit/out/: ${x.fixitOutReads.turns}`);
    const m = x.modelCheck;
    L.push(`  model check: ${m.agentCalls} Agent calls; ${m.withRequestedModel} set a model, ${m.comparable} of those linked to a subagent transcript, ${m.mismatches} mismatched`);
    L.push(`  ${m.noRequestRecorded} calls record no requested model (frontmatter and skill models are not in transcripts), so only the actual model is known for them`);
    return L;
  }
  const t = A.tokenShares;
  L.push(`share: cache read ${t.cacheRead}%, cache write ${t.cacheWrite}%, output ${t.output}%, input ${t.input}%  | main ${A.mainShare}%, subagents ${A.subagentShare}%`);
  L.push(`context: avg ${k(A.context.avg)}, peak ${k(A.context.peak)} (main avg ${k(A.context.mainAvg)} peak ${k(A.context.mainPeak)}; subagent avg ${k(A.context.subAvg)} peak ${k(A.context.subPeak)})`);
  L.push(`compactions: ${A.compactions.count}${A.compactions.count ? `, avg ${k(A.compactions.avgPreTokens)} before, max ${k(A.compactions.maxPreTokens)}` : ""}`);
  if (A.groups) {
    L.push(`by ${A.groups.by}:`);
    L.push(`  ${pad("group", 34)} ${"turns".padStart(6)} ${"avg".padStart(6)} ${"peak".padStart(6)} ${"cold".padStart(5)} ${"weighted".padStart(8)} ${"share".padStart(6)}`);
    const room = 40 - L.length - 1, rows = A.groups.rows;
    for (const r of rows.slice(0, Math.max(room, 1))) L.push(`  ${pad(r.group, 34)} ${String(r.turns).padStart(6)} ${k(r.avgCtx || 0).padStart(6)} ${k(r.peakCtx || 0).padStart(6)} ${String(r.coldWrites ?? "").padStart(5)} ${k(r.weighted).padStart(8)} ${(r.share + "%").padStart(6)}`);
    if (rows.length > room) L.push(`  +${rows.length - room} more (use --json)`);
    return L;
  }
  L.push(`cold writes: ${A.coldWrites.count} (${Object.entries(A.coldWrites.byReason).map(([n, x]) => `${n} ${x.count}/${x.share}%`).join(", ") || "none"})`);
  L.push("share by context size: " + A.bands.map((b) => `${b.band} ${b.share}%`).join(", "));
  L.push("by action: " + A.byAction.slice(0, 6).map((a) => `${a.group} ${a.share}%`).join(", "));
  L.push("by bash kind: " + A.byKind.slice(0, 6).map((a) => `${a.group} ${a.share}%`).join(", "));
  L.push("by model: " + A.byModel.slice(0, 5).map((a) => `${a.group} ${a.share}%`).join(", "));
  L.push(`bash results over 10k chars: ${A.toolResults.bashOver10k} of ${A.toolResults.bashResults}, largest ${A.toolResults.bashLargest}`);
  L.push("by project (top):");
  for (const r of A.byProject.slice(0, 8)) L.push(`  ${pad(r.group.slice(-40), 40)} ${String(r.turns).padStart(6)} turns ${(r.share + "%").padStart(7)}`);
  L.push("more: --by session|agent|item|kind|model, --waste, --json");
  return L;
}

// Where `remedy run` recorded costs on items, if a ledger is reachable. Never required.
function recordedCost(opt) {
  try {
    const dir = path.join(process.env.REMEDY_DIR || path.join(process.cwd(), ".remedy"), "items");
    let usd = 0, n = 0;
    for (const f of fs.readdirSync(dir)) {
      const c = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).cost;
      if (c && typeof c.usd === "number" && c.usd > 0) { usd += c.usd; n++; }
    }
    return n ? `recorded cost on ${n} ledger items: $${usd.toFixed(2)} (from remedy run, not from transcripts)` : "";
  } catch { return ""; }
}

function main(opt, say) {
  const C = collect(opt);
  const A = analyse(C, opt);
  if (opt.json) say(JSON.stringify(A, null, 2));
  else for (const l of render(A, opt)) say(l);
  return A;
}

module.exports = { main, collect, analyse, render, readTranscript, kindOf, UsageError, KINDS };
