#!/usr/bin/env node
/* fixit: run tests and read the result in at most 40 lines. Zero dependencies, Node >= 18.
 *
 *   fixit test <lane|file> [--grep NAME] [--failed] [--changed] [--repeat N] [--bg] [--no-cache]
 *   fixit wait <run> [--timeout SEC]      fixit show <run> [--test NAME]      fixit clean [--days N]
 *   fixit logs <source> --since T [--until T] [--level L] [--diff <run|time>] [--grep P] [--around N] [--run R]
 *
 * Every run is kept in <main checkout>/.fixit/runs/<id>/ (raw.log, report.json,
 * meta.json, digest.txt, digest-full.txt), on success too. Log runs: <main checkout>/.fixit/logs/<id>/.
 * Exit codes: 0 pass or flaky only, 1 failures, 2 could not run or bad usage, 3 STOP.
 * Environment: FIXIT_DIR (state dir), FIXIT_TIMEOUT_SEC, FIXIT_LOCK_POLL_MS, FIXIT_LOCK_WAIT_SEC.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");
const { ADAPTERS, strip, sq, FAIL_LINE } = require("./lib/test-adapters.cjs");
const LOGS = require("./lib/log-adapters.cjs");

const MAX_LINES = 40, MAX_COL = 200, SHOW_LINES = 80;
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trunc = (s, n = MAX_COL) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const readJSON = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
function writeJSON(p, v) { const t = `${p}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(v, null, 1) + "\n"); fs.renameSync(t, p); }
const tryJSON = (p, d) => { try { return readJSON(p); } catch { return d; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
class Usage extends Error {}
const die = (m) => { throw new Usage(m); };

// ---------- git and paths ----------
const underPath = (file, prefix) => file.startsWith(String(prefix).replace(/^\.(\/|$)/, ""));
function git(cwd, args, o = {}) {
  const r = cp.spawnSync("git", args, { cwd, encoding: o.buffer ? "buffer" : "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
  return r.status === 0 ? r.stdout : null;
}
function repoRoot(cwd) { const t = git(cwd, ["rev-parse", "--show-toplevel"]); return t ? t.trim() : path.resolve(cwd); }
// The main checkout, so that every worktree shares one .fixit/ (runs, locks, caches).
function mainRoot(cwd) {
  const c = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (c) { const abs = c.trim(); if (path.basename(abs) === ".git") return path.dirname(abs); }
  return repoRoot(cwd);
}
function stateDir(cwd) {
  const d = process.env.FIXIT_DIR ? path.resolve(process.env.FIXIT_DIR) : path.join(mainRoot(cwd), ".fixit");
  fs.mkdirSync(path.join(d, "runs"), { recursive: true });
  const ig = path.join(d, ".gitignore"); // shared with the output guard; logs can hold secrets
  if (!fs.existsSync(ig)) { try { fs.writeFileSync(ig, "*\n", { flag: "wx" }); } catch { /* the guard won the race */ } }
  return d;
}
const EXCLUDE = [":(exclude).fixit", ":(exclude).remedy"];
const SKIP_PREFIX = /^(\.fixit|\.remedy)(\/|$)/;

// What the tree is: HEAD, the diff against it, and untracked files, never the tool's own directories.
function treeState(root) {
  const head = (git(root, ["rev-parse", "HEAD"]) || "").trim();
  if (!git(root, ["rev-parse", "--git-dir"])) return { head: "nogit", dirty: false, hash: null, short: "nogit" };
  const h = crypto.createHash("sha1");
  let dirty = false;
  if (head) {
    const d = git(root, ["diff", "HEAD", "--binary", "--no-ext-diff", "--", ".", ...EXCLUDE], { buffer: true });
    if (d && d.length) { h.update(d); dirty = true; }
  }
  const un = git(root, ["ls-files", "-z", "-o", ...(head ? [] : ["-c"]), "--exclude-standard"], { buffer: true });
  const names = un ? un.toString("utf8").split("\0").filter((n) => n && !SKIP_PREFIX.test(n)).sort() : [];
  for (const n of names) {
    h.update("\0U" + n + "\0");
    try { h.update(fs.readFileSync(path.join(root, n))); } catch { h.update("?"); }
    dirty = true;
  }
  return { head: head || "nohead", dirty, hash: h.digest("hex"), short: (head || "nohead").slice(0, 7) };
}

// ---------- config and targets ----------
function loadConfig(root) {
  const f = path.join(root, "fixit.config.json");
  if (!fs.existsSync(f)) return {};
  try { return readJSON(f); } catch (e) { die(`fixit.config.json is not valid JSON: ${e.message}`); }
}
const onPath = (bin) => (process.env.PATH || "").split(path.delimiter).some((d) => { try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); return true; } catch { return false; } });
// With no config, a test file runs the runner on PATH, else the project's own through npx (which finds node_modules/.bin).
const runner = (bin, rest) => (onPath(bin) ? `${bin} ${rest}` : `npx --no-install ${bin} ${rest}`);
// npx failing on a runner the project does not have reads as a red test. Declared but not installed still counts, because
// that is a true failure: a fresh worktree needs its setup.
function hasRunner(root, bin) {
  const p = tryJSON(path.join(root, "package.json"), null);
  return onPath(bin) || fs.existsSync(path.join(root, "node_modules", ".bin", bin)) || !!(p?.dependencies?.[bin] || p?.devDependencies?.[bin]);
}
// go test takes packages, not files: a test file runs as the directory holding it, relative to where go runs.
const goPackage = (cwd) => (f) => "./" + path.relative(cwd, path.dirname(f)).split(path.sep).join("/");
// The module holding the file, which need not be the repository root.
function goModule(root, file) {
  let d = path.dirname(file);
  while (d !== "." && !fs.existsSync(path.join(root, d, "go.mod"))) d = path.dirname(d);
  return d;
}
const IMPLIED = [
  { re: /_test\.go$/, adapter: "gotest", cmd: "go test {file}", at: (root, file) => { const cwd = goModule(root, file); return { cwd, fileArg: goPackage(cwd) }; } },
  { re: /_test\.dart$/, adapter: "flutter", cmd: "flutter test {file}" },
  { re: /\.spec\.[cm]?[jt]sx?$/, adapter: "playwright", get cmd() { return runner("playwright", "test {file}"); }, when: (root) => fs.readdirSync(root).some((n) => /^playwright\.config\./.test(n)) },
  { re: /\.(test|spec)\.[cm]?[jt]sx?$/, adapter: "vitest", get cmd() { return runner("vitest", "run {file}"); }, when: (root) => hasRunner(root, "vitest") },
];
function fileRule(cfg, root, file) {
  for (const r of cfg.fileRules || []) {
    if ((!r.match || file.startsWith(r.match)) && (!r.suffix || file.endsWith(r.suffix))) return { ...r, fileArg: r.adapter === "gotest" ? goPackage(r.cwd || ".") : undefined };
  }
  for (const r of IMPLIED) if (r.re.test(file) && (!r.when || r.when(root))) return r.at ? { ...r, ...r.at(root, file) } : r;
  return null;
}
const fillFiles = (cmd, files, rule) => cmd.replace(/\{file\}/g, files.map((f) => sq(rule && rule.fileArg ? rule.fileArg(f) : f)).join(" "));

// ---------- locks ----------
function lockFile(sd, name) { fs.mkdirSync(path.join(sd, "locks"), { recursive: true }); return path.join(sd, "locks", name.replace(/[^\w.-]/g, "_") + ".lock"); }
async function acquire(sd, name, runId, onWait) {
  const f = lockFile(sd, name), poll = +process.env.FIXIT_LOCK_POLL_MS || 500, limit = (+process.env.FIXIT_LOCK_WAIT_SEC || 3600) * 1000, t0 = Date.now();
  for (;;) {
    try { fs.writeFileSync(f, JSON.stringify({ pid: process.pid, run: runId, at: new Date().toISOString() }), { flag: "wx" }); return f; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      const h = tryJSON(f, null);
      if (!h || !alive(h.pid)) { try { fs.rmSync(f); } catch { /* raced */ } continue; }
      if (Date.now() - t0 > limit) return { held: h };
      if (onWait) onWait(h);
      await sleep(poll);
    }
  }
}

// ---------- runs ----------
// Sortable: date, time, milliseconds. Two runs in one millisecond get the next free one.
function newRunId(sd, sub = "runs") {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  for (let t = Date.now(); ; t++) {
    const d = new Date(t), id = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
    if (!fs.existsSync(path.join(sd, sub, id))) { fs.mkdirSync(path.join(sd, sub), { recursive: true }); fs.mkdirSync(path.join(sd, sub, id)); return id; }
  }
}
const runPath = (sd, id) => path.join(sd, "runs", id);
function listRuns(sd) { try { return fs.readdirSync(path.join(sd, "runs")).filter((n) => /^\d{8}-/.test(n)).sort(); } catch { return []; } }
function findRun(sd, ref) {
  const all = listRuns(sd);
  if (!ref || ref === "last" || ref === "latest") return all[all.length - 1] || die("No runs yet.");
  const m = all.filter((r) => r === ref || r.startsWith(ref));
  if (m.length === 1) return m[0];
  die(m.length ? `Run "${ref}" is ambiguous (${m.slice(-3).join(", ")}).` : `No run "${ref}".`);
}
const rel = (root, p) => path.relative(root, p) || ".";

function finalizeLine(m) { return m.status === "queued" || m.status === "waiting" || m.status === "running"; }

// ---------- digest ----------
const oneLine = (s, n = 190) => trunc(strip(s).split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join(" | "), n);
function normMsg(s) { return strip(s).split("\n").find((l) => l.trim()) .replace(/0x[0-9a-f]+/gi, "#").replace(/\b[0-9a-f]{8,}\b/gi, "#").replace(/\d+(\.\d+)?/g, "#").replace(/\s+/g, " ").trim(); }
function signature(f) {
  const frameFile = f.frame ? f.frame.split(":")[0] : f.file || "";
  return sha1([f.name, f.msg ? normMsg(f.msg) : "", frameFile].join("\0")).slice(0, 12);
}
const where = (f) => (f.file ? `${f.file}${f.line ? ":" + f.line : ""}` : "");
function groupFailures(fs_) {
  const g = new Map();
  for (const f of fs_) { const k = f.sig; if (!g.has(k)) g.set(k, { ...f, n: 0 }); g.get(k).n++; }
  return [...g.values()];
}
function buildDigest(m, rep, root, sd) {
  const pre = m.cached ? "" : "";
  const secs = (m.durationMs / 1000).toFixed(1);
  const head = trunc(`fixit test ${m.label}  sha ${m.shortSha}${m.dirty ? "+dirty" : ""}  ${secs}s  (ran: ${trunc(m.cmdShown, 80)})`);
  const c = rep.counts, num = (n) => (n < 0 ? "?" : n);
  const counts = rep.generic ? `exit ${m.cmdExit}  failures found by scan ${rep.failures.length}${m.note ? "  " + m.note : ""}` : `pass ${num(c.pass)}  fail ${c.fail}  skip ${num(c.skip)}  flaky ${rep.flaky.length}${m.note ? "  " + m.note : ""}`;
  const tail = [];
  const runDir = rel(root, runPath(sd, m.id));
  const full = path.join(runDir, "digest-full.txt");
  const groups = groupFailures(rep.failures);
  const flakyShown = rep.flaky.slice(0, 3);
  const flakyLines = flakyShown.map((f) => trunc(`FLAKY ${where(f) || "-"} "${f.name}": passed on repeat; both logs kept`));
  if (rep.flaky.length > 3) flakyLines.push(`${rep.flaky.length - 3} further flaky tests in ${full}`);
  if (m.result === "empty") tail.push(trunc(`NOTHING RAN: no test matched${m.grep ? ` --grep "${m.grep}"` : ""}. This is not a pass; check the test name.`));
  if (m.stop) tail.push(trunc(`STOP: same failure twice (runs ${m.stop.join(", ")}). Write your report and return.`));
  tail.push(`run ${m.id}`);
  const lines = [head, counts];
  const room = MAX_LINES - lines.length - tail.length - flakyLines.length - 1; // 1 for the overflow line
  const body = [];
  let shown = 0;
  for (const g of groups) {
    if (g.tail) { const take = g.tail.slice(-Math.max(3, Math.min(g.tail.length, room - body.length - 1))); if (body.length + 1 + take.length > room && shown) break; body.push(trunc("FAIL " + g.name)); take.forEach((l) => body.push(trunc("  " + l))); shown++; continue; }
    const need = g.generic || !g.msg && !g.frame ? 1 : 2;
    if (body.length + need > room) break;
    body.push(trunc(`FAIL${g.n > 1 ? ` (x${g.n})` : ""} ${where(g) ? where(g) + " " : ""}${g.name}`));
    if (need === 2) body.push(trunc(`  ${oneLine(g.msg) || "(no message)"}${g.frame && g.frame !== where(g) ? "    at " + g.frame : ""}`));
    shown++;
  }
  const hidden = groups.length - shown;
  const out = [...lines, ...body, ...flakyLines];
  if (hidden > 0) out.push(`${hidden} further failure${hidden > 1 ? "s" : ""} in ${full}`);
  out.push(...tail);
  const fullTxt = [head, counts, ""];
  for (const g of groups) {
    fullTxt.push(`FAIL${g.n > 1 ? ` (x${g.n})` : ""} ${where(g) ? where(g) + " " : ""}${g.name}`);
    if (g.tail) g.tail.forEach((l) => fullTxt.push("  " + l));
    for (const l of strip(g.msg || "").split("\n").slice(0, 12)) fullTxt.push("  " + l);
    if (g.frame) fullTxt.push("  at " + g.frame);
    fullTxt.push("");
  }
  for (const f of rep.flaky) fullTxt.push(`FLAKY ${where(f)} "${f.name}": passed on repeat`);
  return { digest: out.slice(0, MAX_LINES).join("\n") + "\n", full: fullTxt.join("\n") + "\n", pre };
}

// ---------- the count behind STOP ----------
// One file per worktree, so parallel worktrees can neither trip each other nor lose each other's counts.
const failuresFile = (sd, root) => path.join(sd, "failures", sha1(root).slice(0, 10) + ".json");
// Keyed by failure signature alone, so a file run, a lane run and --changed all count towards the same STOP.
// An entry goes when a run that exercised that test no longer reports that failure: a run with a label the failure
// was seen under, or one that reported the failure's file. A --grep run counts only if the grep names that test.
// A run of something unrelated leaves it alone. Returns the two run ids for STOP, or null.
function failureCounts(sd, root, job, rep, runId) {
  const fp = failuresFile(sd, root), db = tryJSON(fp, {}), files = new Set(rep.files || []);
  const named = (e) => !job.grep || String(e.name).includes(job.grep) || String(job.grep).includes(e.name);
  const exercised = (e) => named(e) && ((e.labels || []).includes(job.label) || (e.file && files.has(e.file)));
  const current = new Set(rep.failures.map((f) => f.sig));
  for (const k of Object.keys(db)) if (!current.has(k) && exercised(db[k])) delete db[k];
  let stop = null;
  for (const f of rep.failures) {
    const e = db[f.sig] || { sig: f.sig, name: f.name, file: f.file || "", labels: [], count: 0, runs: [] };
    if (!e.labels.includes(job.label)) e.labels = [...e.labels, job.label].slice(-20);
    e.count++; e.runs = [...e.runs, runId].slice(-5); db[f.sig] = e;
    if (e.count >= 2 && !stop) stop = e.runs.slice(-2);
  }
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  writeJSON(fp, db);
  return stop;
}

// ---------- executing one run ----------
function runShell(cmd, cwd, env, logFd, timeoutSec) {
  return new Promise((resolve) => {
    const child = cp.spawn("sh", ["-c", cmd], { cwd, env, stdio: ["ignore", logFd, logFd], detached: true });
    let timedOut = false, done = false;
    const kill = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
    const onSig = () => { kill("SIGTERM"); };
    process.once("SIGTERM", onSig); process.once("SIGINT", onSig);
    const t = setTimeout(() => { timedOut = true; kill("SIGTERM"); setTimeout(() => !done && kill("SIGKILL"), 2000).unref(); }, timeoutSec * 1000);
    const fin = (code, signal) => { if (done) return; done = true; clearTimeout(t); process.removeListener("SIGTERM", onSig); process.removeListener("SIGINT", onSig); kill("SIGKILL"); resolve({ code: code == null ? 128 : code, signal, timedOut }); };
    child.on("error", (e) => { fs.writeSync(logFd, `fixit: cannot start: ${e.message}\n`); fin(127); });
    child.on("close", fin);
  });
}

function saveMeta(sd, m) { writeJSON(path.join(runPath(sd, m.id), "meta.json"), m); }

async function attempt(job, m, adapter, file, cmd, focus, tag) {
  const dir = runPath(job.sd, m.id), logPath = path.join(dir, file);
  const reportPath = path.join(dir, tag ? `machine-${tag}.json` : "machine.json");
  let prep;
  try { prep = adapter.prepare({ cmd, reportPath, grep: job.grep, focus }); }
  catch (e) { return { cannot: e.message }; }
  const fd = fs.openSync(logPath, "w", 0o600);
  const cwd = path.join(job.root, job.cwd || ".");
  const env = { ...process.env, ...prep.env, FIXIT_RUN_ID: m.id };
  let r;
  try { r = await runShell(prep.cmd, cwd, env, fd, job.timeoutSec); } finally { fs.closeSync(fd); }
  const raw = fs.readFileSync(logPath, "utf8");
  let rep = adapter.parse({ raw, reportPath, root: job.root, cwd, exit: r.code });
  if (rep.text != null) { // a JSON event stream: keep it, and make the log readable
    fs.renameSync(logPath, path.join(dir, `machine-${tag || "0"}.ndjson`));
    fs.writeFileSync(logPath, rep.text, { mode: 0o600 });
  }
  return { r, rep, raw: rep.text != null ? rep.text : raw, prepared: prep.cmd };
}

function reportFrom(a, adapter, job) {
  let { r, rep, raw } = a, note = "";
  if (!rep.ok) { // no report: scan the output instead
    rep = ADAPTERS.generic.parse({ raw, exit: r.code });
    if (r.code !== 0) note = `(no ${adapter.name} report; scanned output)`;
  } else if (r.code !== 0 && !rep.failures.length && !rep.generic) {
    rep = { ...rep, failures: [{ name: `(exit code ${r.code}, no failing test reported)`, file: "", line: 0, msg: "", frame: "", tail: strip(raw).split("\n").filter((l) => l.trim()).slice(-12) }] };
    rep.counts = { ...rep.counts, fail: rep.counts.fail || 1 };
  }
  if (r.timedOut) { rep.failures.unshift({ name: `(timed out after ${job.timeoutSec}s)`, file: "", line: 0, msg: "", frame: "", tail: strip(raw).split("\n").filter((l) => l.trim()).slice(-8) }); rep.counts.fail++; }
  rep.failures.forEach((f) => { f.sig = signature(f); });
  return { rep, note };
}

async function execJob(job) {
  const { sd, root } = job;
  const m = tryJSON(path.join(runPath(sd, job.id), "meta.json"), null) || die("run directory is gone");
  const adapter = ADAPTERS[job.adapter];
  let lock = null;
  const release = () => { if (lock && typeof lock === "string") { try { fs.rmSync(lock); } catch { /* gone */ } lock = null; } };
  process.once("exit", release);
  try {
    if (job.lock) {
      lock = await acquire(sd, job.lock, m.id, (h) => { if (m.status !== "waiting") { m.status = "waiting"; m.waitingFor = h.run; saveMeta(sd, m); } });
      if (lock && lock.held) {
        Object.assign(m, { status: "error", result: "error", exitCode: 2, endedAt: new Date().toISOString(), durationMs: 0 });
        const msg = `fixit test: lock "${job.lock}" still held by run ${lock.held.run} (pid ${lock.held.pid}) after waiting; nothing ran.\n`;
        fs.writeFileSync(path.join(runPath(sd, m.id), "digest.txt"), msg); saveMeta(sd, m); lock = null;
        return { code: 2, text: msg };
      }
    }
    Object.assign(m, { status: "running", pid: process.pid, startedAt: new Date().toISOString(), waitingFor: undefined });
    saveMeta(sd, m);
    const t0 = Date.now(), dir = runPath(sd, m.id);
    const a = await attempt(job, m, adapter, "raw.log", job.cmd, job.focus, "");
    let rep, note = "", cmdExit = 0, ran = job.cmd;
    if (a.cannot) {
      m.status = "error"; m.result = "error"; m.exitCode = 2;
      const msg = `fixit test: ${a.cannot}\n`;
      m.endedAt = new Date().toISOString(); fs.writeFileSync(path.join(dir, "digest.txt"), msg); saveMeta(sd, m);
      return { code: 2, text: msg };
    }
    cmdExit = a.r.code; ran = a.prepared;
    if ((cmdExit === 126 || cmdExit === 127) && (a.rep.generic || !a.rep.ok)) { // the shell could not start the command
      const last = strip(a.raw).split("\n").filter((l) => l.trim()).slice(-1)[0] || "";
      Object.assign(m, { status: "error", result: "error", exitCode: 2, cmdExit, endedAt: new Date().toISOString(), durationMs: Date.now() - t0 });
      const msg = trunc(`fixit test ${m.label}: could not run (exit ${cmdExit}): ${last}`) + `\nlog: ${rel(root, path.join(dir, "raw.log"))}\n`;
      fs.writeFileSync(path.join(dir, "digest.txt"), msg); saveMeta(sd, m);
      return { code: 2, text: msg };
    }
    const first = reportFrom(a, adapter, job);
    rep = { ...first.rep, flaky: first.rep.flaky || [] }; note = first.note;
    let repeats = [];
    // Flakes: re-run the failures up to --repeat times; a test that then passes is flaky.
    for (let i = 1; i <= job.repeat && rep.failures.length && !a.r.timedOut; i++) {
      const focus = rep.failures.filter((f) => f.file || f.name);
      const narrow = adapter.name !== "generic" && first.rep.ok && focus.length === rep.failures.length;
      const b = await attempt(job, m, adapter, `repeat-${i}.log`, job.cmd, narrow ? focus : null, String(i));
      if (b.cannot) break;
      const second = reportFrom(b, adapter, job);
      repeats.push({ n: i, exitCode: b.r.code, log: `repeat-${i}.log` });
      if (b.r.code === 0 && !second.rep.failures.length) { rep.flaky.push(...rep.failures); rep.failures = []; break; }
      if (second.rep.generic || !narrow) { if (b.r.code === 0) { rep.flaky.push(...rep.failures); rep.failures = []; } break; }
      const still = new Set(second.rep.failures.map((f) => f.sig));
      const nowOk = rep.failures.filter((f) => !still.has(f.sig));
      rep.flaky.push(...nowOk);
      rep.failures = rep.failures.filter((f) => still.has(f.sig));
      rep.counts = { ...rep.counts, fail: rep.failures.length };
    }
    rep.counts = { ...rep.counts, fail: rep.failures.length, flaky: rep.flaky.length };
    rep.flaky.forEach((f) => { f.sig = f.sig || signature(f); });
    // A structured run in which no test executed (a --grep that matched nothing, an emptied suite) proves nothing.
    const empty = !rep.generic && !rep.failures.length && !rep.flaky.length && rep.counts.pass === 0;
    const result = rep.failures.length ? "fail" : rep.flaky.length ? "flaky" : empty ? "empty" : "pass";
    // STOP: the same failure twice in this worktree, however it was run. See failureCounts.
    const scope = sha1(root + "\0" + job.label).slice(0, 10);
    const stop = empty ? null : failureCounts(sd, root, job, rep, m.id);
    Object.assign(m, {
      result, status: result, exitCode: stop ? 3 : result === "fail" ? 1 : empty ? 2 : 0, cmdExit, ran, stop, repeats, note: note || undefined,
      endedAt: new Date().toISOString(), durationMs: Date.now() - t0, counts: rep.counts, files: (rep.files || []).slice(0, 2000),
      failures: rep.failures.length, flakyCount: rep.flaky.length, cmdShown: job.cmdShown,
    });
    const { digest, full } = buildDigest(m, rep, root, sd);
    const reportJson = { counts: rep.counts, generic: !!rep.generic, failures: rep.failures.slice(0, 500).map((f) => ({ ...f, msg: strip(f.msg || "").slice(0, 4000) })), flaky: rep.flaky.slice(0, 100), files: m.files };
    writeJSON(path.join(dir, "report.json"), reportJson);
    fs.writeFileSync(path.join(dir, "digest.txt"), digest);
    fs.writeFileSync(path.join(dir, "digest-full.txt"), full);
    saveMeta(sd, m);
    if (m.result === "pass" && job.cacheKey) { const cp_ = path.join(sd, "cache.json"), c = tryJSON(cp_, {}); c[job.cacheKey] = m.id; writeJSON(cp_, c); }
    const lp = path.join(sd, "last.json"), last = tryJSON(lp, {}); last[scope] = m.id; writeJSON(lp, last);
    return { code: m.exitCode, text: digest };
  } finally { release(); }
}

// ---------- fixit test ----------
function parseArgs(argv, bool) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (bool.includes(k)) opt[k] = true;
      else { if (i + 1 >= argv.length) die(`--${k} needs a value`); opt[k] = argv[++i]; }
    } else pos.push(a);
  }
  return { pos, opt };
}
const intOpt = (v, name, d) => { if (v == null) return d; const n = Number(v); if (!Number.isInteger(n) || n < 0) die(`--${name} needs a whole number`); return n; };

function plan(cwd, o) { // what to run: a list of jobs without ids
  const root = repoRoot(cwd), cfg = loadConfig(root), arg = o.pos[0];
  const base = { root, grep: o.opt.grep, repeat: intOpt(o.opt.repeat, "repeat", 0), noCache: !!o.opt["no-cache"] };
  const timeoutFor = (lane) => +process.env.FIXIT_TIMEOUT_SEC || (lane && lane.timeoutSec) || 1800;
  const mk = (x) => ({ ...base, cwd: ".", cacheable: true, timeoutSec: timeoutFor(), ...x });
  // Runs only what fixit.config.json names, so an allow rule for `fixit test` cannot run an arbitrary command.
  if (o.opt.cmd !== undefined) die("fixit test takes a lane or a test file, not --cmd. Add a lane to fixit.config.json.");
  const lanes = cfg.lanes || {};
  const fromLane = (name) => {
    const l = lanes[name];
    if (!l.cmd) die(`Lane "${name}" has no cmd in fixit.config.json.`);
    const adapter = l.adapter || "generic";
    if (!ADAPTERS[adapter]) die(`Lane "${name}": unknown adapter "${adapter}".`);
    return mk({ label: name, lane: name, adapter, cmd: l.cmd.replace(/\{grep\}/g, o.opt.grep ? sq(o.opt.grep) : ""), cwd: l.cwd || ".", lock: l.lock, cacheable: l.cacheable !== false, bg: !!l.bg, timeoutSec: timeoutFor(l) });
  };
  if (o.opt.changed) {
    const ch = changedFiles(root);
    if (!ch.length) return [];
    const jobs = [], seen = new Set(), tracked = (git(root, ["ls-files"]) || "").split("\n").filter(Boolean);
    for (const [name, l] of Object.entries(lanes)) {
      if ((l.paths || []).some((p) => ch.some((f) => underPath(f, p)))) { jobs.push(fromLane(name)); seen.add(name); }
    }
    const testFiles = new Set();
    const stemOf = (f) => path.basename(f).replace(/(\.(test|spec))?\.[^.]+$/, "").replace(/_test$/, "");
    const isTest = (f) => /(\.(test|spec)\.[cm]?[jt]sx?|_test\.(go|dart))$/.test(f);
    for (const f of ch) {
      if (isTest(f) && fs.existsSync(path.join(root, f))) testFiles.add(f);
      else if (!isTest(f)) for (const t of tracked) if (isTest(t) && stemOf(t) === stemOf(f) && path.basename(t) !== path.basename(f)) testFiles.add(t);
    }
    const groups = new Map();
    for (const f of testFiles) {
      if ([...seen].some((n) => (lanes[n].paths || []).some((p) => underPath(f, p)))) continue; // its lane already runs
      const rule = fileRule(cfg, root, f); if (!rule) continue;
      const k = (rule.adapter || "generic") + "\0" + (rule.cwd || ".") + "\0" + rule.cmd;
      if (!groups.has(k)) groups.set(k, { rule, files: [] });
      groups.get(k).files.push(f);
    }
    for (const { rule, files } of groups.values()) {
      const cwdRel = rule.cwd || ".", inner = files.map((f) => path.relative(path.join(root, cwdRel), path.join(root, f)).split(path.sep).join("/"));
      jobs.push(mk({ label: `changed:${rule.adapter}:${sha1(files.join(",")).slice(0, 6)}`, adapter: rule.adapter || "generic", cmd: fillFiles(rule.cmd, rule.fileArg ? files : inner, rule), cwd: cwdRel }));
    }
    return jobs;
  }
  if (!arg) {
    if (o.opt.failed) return [{ ...base, failedLast: true }];
    die("Usage: fixit test <lane|file> [--grep NAME] [--failed] [--changed] [--repeat N] [--bg] [--no-cache]\n       lanes: " + (Object.keys(lanes).join(", ") || "(no fixit.config.json)"));
  }
  if (lanes[arg]) return [fromLane(arg)];
  const abs = [path.resolve(cwd, arg), path.resolve(root, arg)].find((p) => fs.existsSync(p));
  if (!abs) die(`"${arg}" is neither a lane nor an existing file. Lanes: ${Object.keys(lanes).join(", ") || "(none; no fixit.config.json)"}`);
  const file = path.relative(root, abs).split(path.sep).join("/");
  if (file.startsWith("..")) die(`"${arg}" is outside this checkout.`);
  const rule = fileRule(cfg, root, file);
  if (!rule) die(`No adapter for ${file}. Add a fileRules entry to fixit.config.json.`);
  const cwdRel = rule.cwd || ".", inner = path.relative(path.join(root, cwdRel), abs).split(path.sep).join("/");
  return [mk({ label: file, adapter: rule.adapter || "generic", cmd: fillFiles(rule.cmd.replace(/\{grep\}/g, o.opt.grep ? sq(o.opt.grep) : ""), rule.fileArg ? [file] : [inner], rule), cwd: cwdRel, targetFile: file })];
}
function changedFiles(root) {
  const a = (git(root, ["diff", "HEAD", "--name-only", "--", ".", ...EXCLUDE]) || "").split("\n");
  const b = (git(root, ["ls-files", "-o", "--exclude-standard"]) || "").split("\n");
  return [...new Set([...a, ...b])].filter((f) => f && !SKIP_PREFIX.test(f));
}

function lastFailures(sd, scopeLabel, root) {
  const scope = sha1(root + "\0" + scopeLabel).slice(0, 10);
  const id = tryJSON(path.join(sd, "last.json"), {})[scope];
  return id ? { id, rep: tryJSON(path.join(runPath(sd, id), "report.json"), null), meta: tryJSON(path.join(runPath(sd, id), "meta.json"), null) } : null;
}

async function cmdTest(argv, cwd) {
  const o = parseArgs(argv, ["failed", "changed", "bg", "no-cache"]);
  const sd = stateDir(cwd);
  let jobs = plan(cwd, o);
  if (!jobs.length) { console.log("fixit test: no changed files map to a lane or test file; nothing ran."); return 0; }
  if (jobs[0].failedLast) { // no target given: newest run that had failures
    const root = jobs[0].root;
    const runs = listRuns(sd).reverse();
    const meta = runs.map((r) => tryJSON(path.join(runPath(sd, r), "meta.json"), null)).find((x) => x && x.root === root && x.label && !finalizeLine(x));
    if (!meta) die("--failed: no earlier run in this checkout.");
    jobs = [{ ...jobs[0], root, failedLast: false, label: meta.label, lane: meta.lane, adapter: meta.adapter, cmd: meta.jobCmd, cwd: meta.cwd, lock: meta.lock, timeoutSec: meta.timeoutSec || 1800, cacheable: false }];
  }
  const codes = [], multi = jobs.length > 1;
  for (const job of jobs) {
    job.sd = sd;
    if (o.opt.failed) {
      const last = lastFailures(sd, job.label, job.root);
      if (!last || !last.rep) { console.log(`fixit test ${job.label}: --failed: no earlier run of this target.`); codes.push(2); continue; }
      const fl = (last.rep.failures || []).filter((f) => f.file || f.name);
      if (!fl.length) { console.log(`fixit test ${job.label}: the last run (${last.id}) had no failures; nothing to re-run.`); codes.push(0); continue; }
      job.focus = fl;
    }
    job.cmdShown = job.cmd;
    const ts = treeState(job.root);
    const useCache = job.cacheable && !job.noCache && !job.focus && ts.hash;
    job.cacheKey = ts.hash && job.cacheable ? sha1([ts.head, ts.hash, job.cmd, job.cwd, job.grep || ""].join("\0")) : null;
    if (useCache) {
      const hit = tryJSON(path.join(sd, "cache.json"), {})[job.cacheKey];
      const hm = hit && tryJSON(path.join(runPath(sd, hit), "meta.json"), null);
      if (hm && hm.result === "pass") { console.log(`fixit test ${job.label}: already green at ${ts.short}${ts.dirty ? "+dirty" : ""} (run ${hit}); nothing ran. --no-cache forces a run.`); codes.push(0); continue; }
    }
    job.id = newRunId(sd);
    const dir = runPath(sd, job.id);
    const meta = { id: job.id, label: job.label, lane: job.lane, target: job.targetFile, adapter: job.adapter, jobCmd: job.cmd, cmdShown: job.cmd, cwd: job.cwd, lock: job.lock, timeoutSec: job.timeoutSec, root: job.root, sha: ts.head, shortSha: ts.short, dirty: ts.dirty, status: "queued", result: null, exitCode: null, grep: job.grep, createdAt: new Date().toISOString() };
    saveMeta(sd, meta);
    fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(job));
    if (o.opt.bg || (job.bg && !multi && !o.opt.failed)) {
      const child = cp.spawn(process.execPath, [__filename, "_exec", job.id], { cwd: job.root, detached: true, stdio: "ignore", env: { ...process.env, FIXIT_DIR: sd } });
      child.unref();
      meta.pid = child.pid; saveMeta(sd, meta);
      console.log(`started ${job.id}  ${job.label}${job.lock ? `  (lock ${job.lock})` : ""}\nfixit wait ${job.id}`);
      codes.push(0); continue;
    }
    const r = await execJob(job);
    process.stdout.write(multi ? r.text.split("\n").slice(0, Math.max(6, Math.floor(36 / jobs.length))).join("\n") + "\n" : r.text);
    codes.push(r.code);
  }
  return codes.includes(3) ? 3 : codes.includes(1) ? 1 : codes.includes(2) ? 2 : 0;
}

async function cmdExec(argv, cwd) {
  const sd = stateDir(cwd), job = readJSON(path.join(runPath(sd, argv[0]), "job.json"));
  job.sd = sd;
  const r = await execJob(job);
  return r.code;
}

// ---------- wait, show, clean ----------
async function cmdWait(argv, cwd) {
  const o = parseArgs(argv, []), sd = stateDir(cwd), id = findRun(sd, o.pos[0]);
  const limit = intOpt(o.opt.timeout, "timeout", 270), t0 = Date.now(), mp = path.join(runPath(sd, id), "meta.json");
  for (;;) {
    const m = tryJSON(mp, null) || die(`Run ${id} has no meta.json.`);
    if (finalizeLine(m) && m.pid && !alive(m.pid) && m.status !== "queued") { Object.assign(m, { status: "died", result: "error", exitCode: 2 }); saveMeta(sd, m); fs.writeFileSync(path.join(runPath(sd, id), "digest.txt"), `fixit: run ${id} died without finishing (see ${rel(m.root, path.join(runPath(sd, id), "raw.log"))}).\n`); }
    else if (m.status === "queued" && m.pid && !alive(m.pid)) { Object.assign(m, { status: "died", result: "error", exitCode: 2 }); saveMeta(sd, m); }
    if (!finalizeLine(m)) {
      const dg = path.join(runPath(sd, id), "digest.txt");
      process.stdout.write(fs.existsSync(dg) ? fs.readFileSync(dg, "utf8") : `run ${id}: ${m.status}\n`);
      return m.exitCode == null ? 0 : m.exitCode;
    }
    if (Date.now() - t0 >= limit * 1000) {
      console.log(`running  ${id}  ${m.label}  ${m.status === "waiting" ? `waiting for lock (held by ${m.waitingFor})` : `${Math.round((Date.now() - Date.parse(m.startedAt || m.createdAt)) / 1000)}s so far`}\nnot finished: fixit wait ${id}`);
      return 0;
    }
    await sleep(Math.min(500, Math.max(50, limit * 1000 - (Date.now() - t0))));
  }
}

function cmdShow(argv, cwd) {
  const o = parseArgs(argv, []), sd = stateDir(cwd), id = findRun(sd, o.pos[0]), dir = runPath(sd, id);
  const m = tryJSON(path.join(dir, "meta.json"), {});
  let lines;
  if (o.opt.test) {
    const rep = tryJSON(path.join(dir, "report.json"), null) || die(`Run ${id} has no report yet (${m.status}).`);
    const q = String(o.opt.test).toLowerCase(), hit = [...rep.failures, ...rep.flaky].filter((f) => f.name.toLowerCase().includes(q) || (f.file || "").toLowerCase().includes(q));
    if (!hit.length) die(`No failing test matching "${o.opt.test}" in ${id}. Failing: ${rep.failures.slice(0, 5).map((f) => f.name).join("; ") || "none"}`);
    lines = [];
    for (const f of hit) {
      lines.push(`${rep.flaky.includes(f) ? "FLAKY" : "FAIL"} ${where(f) ? where(f) + " " : ""}${f.name}`);
      (f.tail || []).forEach((l) => lines.push("  " + l));
      strip(f.msg || "").split("\n").forEach((l) => lines.push("  " + l));
      if (f.frame) lines.push("  at " + f.frame);
      lines.push("");
    }
  } else {
    const p = path.join(dir, "digest-full.txt");
    lines = fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n") : [`run ${id}: ${m.status}`];
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  const out = lines.slice(0, SHOW_LINES).map((l) => trunc(l));
  if (lines.length > SHOW_LINES) out.push(`+${lines.length - SHOW_LINES} lines: sed -n '${SHOW_LINES + 1},${lines.length}p' ${rel(m.root || process.cwd(), path.join(dir, o.opt.test ? "report.json" : "digest-full.txt"))}`);
  out.push(`raw log: ${rel(m.root || process.cwd(), path.join(dir, "raw.log"))}`);
  console.log(out.join("\n"));
  return 0;
}

function cmdClean(argv, cwd) {
  const o = parseArgs(argv, []), sd = stateDir(cwd), days = intOpt(o.opt.days, "days", 14), cutoff = Date.now() - days * 864e5;
  let n = 0, bytes = 0;
  const size = (d) => { let s = 0; for (const f of fs.readdirSync(d)) { try { s += fs.statSync(path.join(d, f)).size; } catch { /* gone */ } } return s; };
  const gone = new Set();
  for (const id of listRuns(sd)) {
    const dir = runPath(sd, id), m = tryJSON(path.join(dir, "meta.json"), null);
    if (m && finalizeLine(m) && m.pid && alive(m.pid)) continue;
    const t = m && (m.endedAt || m.createdAt) ? Date.parse(m.endedAt || m.createdAt) : fs.statSync(dir).mtimeMs;
    if (t > cutoff) continue;
    bytes += size(dir); fs.rmSync(dir, { recursive: true, force: true }); gone.add(id); n++;
  }
  for (const f of ["cache.json", "last.json"]) { const p = path.join(sd, f), j = tryJSON(p, null); if (j) { for (const k of Object.keys(j)) if (gone.has(j[k])) delete j[k]; writeJSON(p, j); } }
  try {
    for (const f of fs.readdirSync(path.join(sd, "failures"))) {
      const fp = path.join(sd, "failures", f), fdb = tryJSON(fp, {});
      for (const k of Object.keys(fdb)) if (!fdb[k].runs.some((r) => !gone.has(r))) delete fdb[k];
      if (Object.keys(fdb).length) writeJSON(fp, fdb); else fs.rmSync(fp, { force: true });
    }
  } catch { /* no counts yet */ }
  try { for (const f of fs.readdirSync(path.join(sd, "guard"))) { const p = path.join(sd, "guard", f); if (fs.statSync(p).mtimeMs <= cutoff) fs.rmSync(p, { force: true }); } } catch { /* the context guard has not run here */ }
  let logRuns = 0;
  try {
    for (const id of fs.readdirSync(logsDirOf(sd))) {
      const dir = path.join(logsDirOf(sd), id), m = tryJSON(path.join(dir, "meta.json"), null);
      const t = m && m.createdAt ? Date.parse(m.createdAt) : fs.statSync(dir).mtimeMs;
      if (/^\d{8}-/.test(id) && t <= cutoff) { bytes += size(dir); fs.rmSync(dir, { recursive: true, force: true }); logRuns++; }
    }
  } catch { /* no logs */ }
  let stale = 0;
  try { for (const f of fs.readdirSync(path.join(sd, "locks"))) { const h = tryJSON(path.join(sd, "locks", f), null); if (!h || !alive(h.pid)) { fs.rmSync(path.join(sd, "locks", f), { force: true }); stale++; } } } catch { /* no locks */ }
  console.log(`clean: removed ${n} run${n === 1 ? "" : "s"} older than ${days} days${logRuns ? ` and ${logRuns} log run${logRuns === 1 ? "" : "s"}` : ""} (${(bytes / 1048576).toFixed(1)} MB), ${stale} stale lock${stale === 1 ? "" : "s"}; ${listRuns(sd).length} kept`);
  return 0;
}

// ---------- logs ----------
const MAX_LOG_LINES = 30, AROUND = 20, VERBATIM_LINES = 20, VERBATIM_CHARS = 4000;
const logsDirOf = (sd) => path.join(sd, "logs");
const hhmmss = (ms) => new Date(ms).toISOString().slice(11, 19);
const fmtN = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
function newestLog(sd) { try { return fs.readdirSync(logsDirOf(sd)).filter((n) => /^\d{8}-/.test(n)).sort().pop() || null; } catch { return null; } }
function findLog(sd, ref) {
  const id = ref || newestLog(sd);
  if (!id) die("No saved log runs in .fixit/logs/ yet.");
  const dir = path.join(logsDirOf(sd), id);
  if (!/^[\w.-]+$/.test(id) || !fs.existsSync(path.join(dir, "raw.log"))) die(`No saved log run "${id}".`);
  return { id, dir };
}
// Group entries into templates: one per normalised message, worst level first, then by count.
function templatesOf(entries) {
  const by = new Map();
  for (const e of entries) {
    let t = by.get(e.key);
    if (!t) { t = { key: e.key, level: e.level, count: 0, first: e.t, last: e.t, example: e.raw, line: e.line }; by.set(e.key, t); }
    t.count++;
    if (LOGS.LEVELS[e.level] > LOGS.LEVELS[t.level]) { t.level = e.level; t.example = e.raw; t.line = e.line; }
    if (e.t != null) { t.first = t.first == null ? e.t : Math.min(t.first, e.t); t.last = t.last == null ? e.t : Math.max(t.last, e.t); }
  }
  return [...by.values()].sort((a, b) => LOGS.LEVELS[b.level] - LOGS.LEVELS[a.level] || b.count - a.count || a.line - b.line);
}
function fetchSource(src, start, end, timeoutSec, tmpDir) {
  const a = LOGS.ADAPTERS[src.kind].fetch({ rest: src.rest, start, end });
  let text;
  if (a.file) {
    try { text = fs.readFileSync(path.resolve(a.file), "utf8"); } catch (e) { die(`cannot read ${a.file}: ${e.code || e.message}`); }
  } else {
    const f = path.join(tmpDir, `fetch-${process.pid}-${Date.now()}.tmp`), fd = fs.openSync(f, "w", 0o600);
    let r;
    try { r = cp.spawnSync(a.argv[0], a.argv.slice(1), { stdio: ["ignore", fd, fd], timeout: timeoutSec * 1000 }); } finally { fs.closeSync(fd); }
    text = fs.readFileSync(f, "utf8"); fs.rmSync(f, { force: true });
    if (r.error) die(r.error.code === "ENOENT" ? `${a.argv[0]} is not installed or not on PATH.` : `${a.argv[0]}: ${r.error.message}`);
    if (r.status !== 0) die(`${a.argv.slice(0, 2).join(" ")} failed (exit ${r.status}): ${trunc(oneLine(text, 160), 160)}`);
  }
  return LOGS.filterWindow(text, start, end);
}
function cmdLogsAround(o, sd) {
  const n = Number(o.opt.around);
  if (!Number.isInteger(n) || n < 1) die("--around needs a line number of at least 1.");
  const { id, dir } = findLog(sd, o.opt.run);
  const all = fs.readFileSync(path.join(dir, "raw.log"), "utf8").split("\n");
  if (all.length && all[all.length - 1] === "") all.pop();
  if (n > all.length) die(`run ${id} has only ${all.length} lines.`);
  const a = Math.max(1, n - AROUND), b = Math.min(all.length, n + AROUND);
  const out = [`fixit logs run ${id}: lines ${a}-${b} of ${all.length} (around ${n})`];
  for (let i = a; i <= b; i++) out.push(trunc(`${i === n ? ">" : " "}${String(i).padStart(String(b).length)}: ${strip(all[i - 1])}`));
  console.log(out.join("\n"));
  return 0;
}
async function cmdLogs(argv, cwd) {
  const o = parseArgs(argv, []);
  const sd = stateDir(cwd); // makes .fixit/ self-ignoring before anything is written under it
  fs.mkdirSync(logsDirOf(sd), { recursive: true, mode: 0o700 });
  if (o.opt.around != null) return cmdLogsAround(o, sd);
  const cfg = loadConfig(repoRoot(cwd));
  const level = o.opt.level ? String(o.opt.level).toLowerCase() : null;
  if (level && !(level in LOGS.LEVELS)) die(`--level is one of: ${Object.keys(LOGS.LEVELS).join(", ")}.`);
  let grep = null;
  if (o.opt.grep) { try { grep = new RegExp(o.opt.grep, "i"); } catch (e) { die(`--grep is not a valid regular expression: ${e.message}`); } }
  const timeoutSec = +process.env.FIXIT_TIMEOUT_SEC || 600;
  const now = Date.now();
  let start = null, end = null;
  if (o.opt.since != null) { start = LOGS.parseTime(o.opt.since, now); if (start == null) die(`--since "${o.opt.since}": use 15m, 2h, 1d or an ISO time.`); end = now; }
  if (o.opt.until != null) { end = LOGS.parseTime(o.opt.until, now); if (end == null) die(`--until "${o.opt.until}": use 15m, 2h, 1d or an ISO time.`); }
  if (start != null && end != null && end <= start) die("--until must be later than --since.");

  let text, label, source = null, runId = null, runDir = null;
  let src = o.pos[0];
  if (o.opt.cmd !== undefined) die("fixit logs takes a source, not --cmd. Use docker:, compose:, journald:, kubectl: or file:, or name one in fixit.config.json.");
  if (o.opt.run && !src) {
    const f = findLog(sd, o.opt.run); runId = f.id; runDir = f.dir; label = `run ${f.id}`;
    text = fs.readFileSync(path.join(f.dir, "raw.log"), "utf8");
  } else {
    if (!src) die("Usage: fixit logs <source> --since T [--until T] [--level error] [--diff <run|time>] [--grep P] [--around N] [--run R]\n       sources: docker:NAME, compose:SERVICE[@file], journald:UNIT, kubectl:[NS/]POD, file:PATH" + (cfg.logs ? ", or one of: " + Object.keys(cfg.logs).join(", ") : ""));
    let named = cfg.logs && Object.prototype.hasOwnProperty.call(cfg.logs, src) ? cfg.logs[src] : null;
    if (named && typeof named === "object") named = named.source;
    if (named != null && typeof named !== "string") die(`logs.${src} in fixit.config.json needs a source string such as "docker:api".`);
    try { source = LOGS.parseSource(named || src); } catch (e) { die(e.message); }
    if (process.env.REMEDY_RUN_ITEM && source.kind === "file" && path.relative(mainRoot(cwd), path.resolve(cwd, source.rest)).startsWith("..")) die("Inside remedy run, a file: log source must be inside the repository.");
    label = (named ? `${src} (` : "") + LOGS.ADAPTERS[source.kind].label(source.rest) + (named ? ")" : "");
    try { text = fetchSource(source, start, end, timeoutSec, logsDirOf(sd)); } catch (e) { if (e instanceof Usage) throw e; die(e.message); }
  }

  const entries = LOGS.readEntries(text);
  const all = templatesOf(entries);
  let baseline = null, baseNote = "";
  if (o.opt.diff != null) {
    const d = String(o.opt.diff);
    if (/^\d{8}-\d{6}/.test(d)) {
      const f = findLog(sd, d);
      const t = tryJSON(path.join(f.dir, "templates.json"), null);
      if (!t) die(`run ${d} has no templates.json.`);
      baseline = new Set(t.map((x) => x.key)); baseNote = `baseline run ${d}`;
    } else {
      const T = LOGS.parseTime(d, now);
      if (T == null) die(`--diff "${d}" is neither a saved run id nor a time (15m, 2h, an ISO time).`);
      if (!source || start == null) die("--diff <time> needs a source and --since, so the baseline can be a window of the same length.");
      if (T > end) die("--diff <time> must not be later than the end of the window.");
      const len = end - start, bStart = T - len;
      let bt;
      try { bt = fetchSource(source, bStart, T, timeoutSec, logsDirOf(sd)); } catch (e) { if (e instanceof Usage) throw e; die(e.message); }
      const be = LOGS.readEntries(bt);
      baseline = new Set(be.map((e) => e.key)); baseNote = `baseline ${LOGS.isoMs(bStart).slice(0, 19)}Z to ${LOGS.isoMs(T).slice(0, 19)}Z, ${fmtN(bt ? bt.split("\n").filter(Boolean).length : 0)} lines`;
    }
  }

  if (!runId) { // save the window in full, before any filter, so it can be a baseline later
    runId = newRunId(sd, "logs"); runDir = path.join(logsDirOf(sd), runId);
    fs.writeFileSync(path.join(runDir, "raw.log"), text, { mode: 0o600 });
    fs.writeFileSync(path.join(runDir, "templates.json"), JSON.stringify(all.slice(0, 20000)), { mode: 0o600 });
    writeJSON(path.join(runDir, "meta.json"), { id: runId, label, source: o.pos[0] || null, start, end, lines: text ? text.split("\n").filter(Boolean).length : 0, templates: all.length, createdAt: new Date().toISOString() });
  }
  const rawRel = rel(mainRoot(cwd), path.join(runDir, "raw.log"));
  const nLines = text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;

  let list = all;
  if (baseline) list = list.filter((t) => !baseline.has(t.key));
  if (level) list = list.filter((t) => LOGS.LEVELS[t.level] >= LOGS.LEVELS[level]);
  if (grep) { const hit = new Set(entries.filter((e) => grep.test(e.raw)).map((e) => e.key)); list = list.filter((t) => hit.has(t.key)); }

  const win = start != null || end != null ? `  window ${start != null ? LOGS.isoMs(start).slice(0, 19) + "Z" : "..."} to ${end != null ? LOGS.isoMs(end).slice(0, 19) + "Z" : "..."}` : "";
  const nErr = all.filter((t) => t.level === "error").length;
  const head = trunc(`fixit logs ${label}${win}  ${fmtN(nLines)} lines  ${fmtN(all.length)} template${all.length === 1 ? "" : "s"} (${nErr} error)`);
  const out = [head];
  const filtered = baseline || level || grep;
  if (!entries.length) out.push("no log lines in the window.");
  else if (!filtered && nLines <= VERBATIM_LINES && text.length <= VERBATIM_CHARS) for (const l of text.replace(/\n$/, "").split("\n")) out.push(trunc(strip(l)));
  else {
    if (baseline) out.push(trunc(`new against ${baseNote}: ${list.length} of ${all.length} templates`));
    const fixed = out.length + 1; // the run line
    const room = MAX_LOG_LINES - fixed;
    let n = list.length;
    if (n * 2 > room) n = Math.floor((room - 1) / 2);
    for (const t of list.slice(0, n)) {
      const when = t.first != null ? `  ${hhmmss(t.first)}${t.last !== t.first ? "–" + hhmmss(t.last) : ""}` : "";
      out.push(trunc(`${t.level.toUpperCase()} x${t.count}${when}  ${t.key}`));
      out.push(trunc(`  L${t.line}: ${t.example}`));
    }
    if (n < list.length) out.push(trunc(`${list.length - n} more templates: narrow with --level error or --grep, or read ${rawRel}`));
    else if (!list.length) out.push(baseline ? "no new templates against the baseline." : "no entries match.");
  }
  out.push(trunc(`run ${runId}  ${rawRel}  (fixit logs --around LINE --run ${runId})`));
  console.log(out.join("\n"));
  return 0;
}

const HELP = `fixit: run tests, read the result in at most 40 lines
  fixit test <lane|file> [--grep NAME] [--failed] [--changed] [--repeat N] [--bg] [--no-cache]
  fixit wait <run> [--timeout SEC]     blocks at most 270 s, then prints the digest or "running"
  fixit show <run> [--test NAME]       the full failure list, or one test in full (at most 80 lines)
  fixit logs <source> --since T [--until T] [--level error] [--diff <run|time>] [--grep P] [--around N] [--run R]
  sources: docker:NAME compose:SERVICE[@file] journald:UNIT kubectl:[NS/]POD file:PATH
  fixit clean [--days N]               remove runs and log runs older than N days (default 14)
Exit: 0 pass or flaky only, 1 failures, 2 could not run or bad usage, 3 STOP (same failure twice).
Runs are kept in <main checkout>/.fixit/runs/<id>/ . Config: fixit.config.json at the repo root.`;

async function main(argv) {
  const [cmd, ...rest] = argv;
  const cwd = process.cwd();
  try {
    if (cmd === "test") return await cmdTest(rest, cwd);
    if (cmd === "wait") return await cmdWait(rest, cwd);
    if (cmd === "show") return cmdShow(rest, cwd);
    if (cmd === "logs") return await cmdLogs(rest, cwd);
    if (cmd === "clean") return cmdClean(rest, cwd);
    if (cmd === "_exec") return await cmdExec(rest, cwd);
    if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { console.log(HELP); return cmd ? 0 : 2; }
    console.error(`fixit: unknown command "${cmd}".\n${HELP}`);
    return 2;
  } catch (e) {
    if (e instanceof Usage) { console.error(`fixit: ${e.message}`); return 2; }
    console.error(`fixit: ${e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n") : e}`);
    return 2;
  }
}
if (require.main === module) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
module.exports = { main, treeState, signature };
