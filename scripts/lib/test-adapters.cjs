/* fixit test adapters: how to ask a runner for a machine-readable report, and
 * how to read it back. Zero dependencies, Node >= 18.
 *
 * An adapter has:
 *   prepare({ cmd, reportPath, grep, focus }) -> { cmd, env }
 *       cmd is the user's command with {file}/{grep} already filled in. focus is
 *       a list of earlier failures ({file, name}) to narrow to, or null.
 *   parse({ raw, reportPath, root, cwd }) -> { ok, counts, failures, files, text? }
 *       ok is false when the report is missing or unreadable (the caller then
 *       falls back to scanning raw output). failures are { name, file, line,
 *       msg, frame }. text, when given, is the readable output rebuilt from a
 *       JSON event stream (go, flutter) and becomes raw.log.
 * File paths in results are relative to the repo root, with forward slashes.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const strip = (s) => String(s == null ? "" : s).replace(ANSI, "");
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const uniq = (a) => [...new Set(a)];
const counts = () => ({ pass: 0, fail: 0, skip: 0, flaky: 0 });
const readJSON = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function relTo(root, cwd, p) {
  if (!p) return "";
  let s = String(p).replace(/^file:\/\//, "");
  const abs = path.isAbsolute(s) ? s : path.resolve(cwd || root, s);
  const r = path.relative(root, abs);
  return (r.startsWith("..") ? abs : r).split(path.sep).join("/");
}
// "Error: message\n    at fn (file:line:col)" -> { msg, frame }. Frames inside node_modules are skipped.
function splitStack(text, root, cwd) {
  const lines = strip(text).split("\n");
  const at = lines.findIndex((l) => /^\s+at\s/.test(l));
  const msgLines = (at < 0 ? lines : lines.slice(0, at)).filter((l) => l.trim());
  let frame = "";
  for (const l of at < 0 ? [] : lines.slice(at)) {
    const m = /^\s+at\s+(?:(.*?)\s+\()?(.+?):(\d+)(?::\d+)?\)?\s*$/.exec(l);
    if (!m || /node_modules|node:internal|\(<anonymous>\)/.test(m[2])) continue;
    frame = `${relTo(root, cwd, m[2])}:${m[3]}${m[1] ? " " + m[1] : ""}`;
    break;
  }
  return { msg: msgLines.join("\n"), frame };
}

// ---------- vitest (jest-shaped JSON) ----------
const vitest = {
  name: "vitest",
  prepare({ cmd, reportPath, grep, focus }) {
    let c = cmd;
    if (focus) c += " " + uniq(focus.map((f) => f.file).filter(Boolean)).map(sq).join(" ");
    if (focus) { const names = uniq(focus.map((f) => f.title || f.name).filter((n) => n && !/^\(/.test(n))); if (names.length) c += ` -t ${sq(names.map(escRe).join("|"))}`; }
    else if (grep) c += ` -t ${sq(grep)}`;
    return { cmd: `${c} --reporter=default --reporter=json --outputFile.json=${sq(reportPath)}`, env: {} };
  },
  parse({ reportPath, root, cwd }) {
    let j; try { j = readJSON(reportPath); } catch { return { ok: false }; }
    if (!Array.isArray(j.testResults)) return { ok: false };
    const c = counts(), failures = [], files = [];
    for (const f of j.testResults) {
      const file = relTo(root, cwd, f.name);
      files.push(file);
      if (!f.assertionResults || !f.assertionResults.length) {
        if (f.status === "failed") { c.fail++; failures.push({ name: "(suite failed to load)", file, line: 0, msg: strip(f.message || "").trim(), frame: "" }); }
        continue;
      }
      for (const t of f.assertionResults) {
        if (t.status === "passed") c.pass++;
        else if (t.status === "failed") {
          c.fail++;
          const { msg, frame } = splitStack((t.failureMessages || []).join("\n"), root, cwd);
          const m = frame && frame.startsWith(file + ":") ? +frame.slice(file.length + 1).split(/[ ]/)[0] : (t.location && t.location.line) || 0;
          failures.push({ name: t.fullName || [...(t.ancestorTitles || []), t.title].join(" "), title: t.title, file, line: m || 0, msg, frame });
        } else c.skip++; // pending, skipped, todo
      }
    }
    return { ok: true, counts: c, failures, files: uniq(files) };
  },
};

// ---------- playwright (JSON reporter) ----------
const playwright = {
  name: "playwright",
  prepare({ cmd, reportPath, grep, focus }) {
    let c = cmd;
    if (focus) c += " " + uniq(focus.map((f) => (f.file ? f.file + (f.line ? ":" + f.line : "") : "")).filter(Boolean)).map(sq).join(" ");
    if (grep) c += ` --grep ${sq(grep)}`;
    return { cmd: `${c} --reporter=list,json`, env: { PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath } };
  },
  parse({ reportPath, root, cwd }) {
    let j; try { j = readJSON(reportPath); } catch { return { ok: false }; }
    if (!Array.isArray(j.suites)) return { ok: false };
    const base = (j.config && j.config.rootDir) || cwd;
    const testDir = (j.config && j.config.projects && j.config.projects[0] && j.config.projects[0].testDir) || base;
    const c = counts(), failures = [], flaky = [], files = [];
    const walk = (s, titles, fileRel) => {
      const file = s.file ? relTo(root, testDir, s.file) : fileRel;
      const isFile = !titles.length && s.file && s.title === path.basename(s.file);
      const t2 = isFile || !s.title ? titles : [...titles, s.title];
      for (const sp of s.specs || []) {
        const sf = relTo(root, testDir, sp.file || s.file);
        files.push(sf);
        for (const t of sp.tests || []) {
          const name = [...t2, sp.title, ...(t.projectName ? [`[${t.projectName}]`] : [])].join(" › ");
          const last = (t.results || [])[t.results.length - 1] || {};
          if (t.status === "skipped" || last.status === "skipped") { c.skip++; continue; }
          if (t.status === "expected") { c.pass++; continue; }
          const first = (t.results || []).find((r) => r.error || (r.errors && r.errors.length)) || last;
          const err = first.error || (first.errors || [])[0] || {};
          const st = splitStack(err.stack || err.message || "", root, cwd);
          const loc = err.location || {};
          const entry = { name, file: sf, line: sp.line || 0, msg: strip(err.message || st.msg).trim(), frame: st.frame || (loc.file ? `${relTo(root, cwd, loc.file)}:${loc.line}` : "") };
          if (t.status === "flaky") { c.flaky++; flaky.push(entry); } else { c.fail++; failures.push(entry); }
        }
      }
      for (const sub of s.suites || []) walk(sub, t2, file);
    };
    for (const s of j.suites) walk(s, [], "");
    return { ok: true, counts: c, failures, flaky, files: uniq(files) };
  },
};

// ---------- go test -json ----------
function goModule(cwd, root) {
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    try {
      const m = /^module\s+(\S+)/m.exec(fs.readFileSync(path.join(d, "go.mod"), "utf8"));
      if (m) return { dir: d, mod: m[1] };
    } catch { /* keep walking */ }
    if (d === path.resolve(root) || d === path.dirname(d)) return null;
  }
}
const gotest = {
  name: "gotest",
  prepare({ cmd, grep, focus }) {
    if (!/\bgo\s+test\b/.test(cmd)) throw new Error("adapter gotest needs a command containing 'go test' (use --adapter generic for a wrapper)");
    let c = cmd.replace(/\bgo\s+test\b/, "go test -json");
    if (focus) {
      const tops = uniq(focus.map((f) => String(f.name).split("/")[0]).filter((n) => /^\w+$/.test(n)));
      if (tops.length) c += ` -run ${sq("^(" + tops.join("|") + ")$")}`;
    } else if (grep) c += ` -run ${sq(grep)}`;
    return { cmd: c, env: {} };
  },
  parse({ raw, root, cwd }) {
    const ev = [];
    for (const l of raw.split("\n")) { if (l[0] !== "{") continue; try { const e = JSON.parse(l); if (e.Action) ev.push(e); } catch { /* build output lines */ } }
    if (!ev.length) return { ok: false };
    const mod = goModule(cwd, root);
    const key = (e) => (e.Test ? `${e.Package}\0${e.Test}` : `${e.Package}\0`);
    const out = new Map(), status = new Map(), build = new Map(), failedBuild = new Map();
    let text = "";
    for (const e of ev) {
      if (e.Action === "build-output") { build.set(e.ImportPath, (build.get(e.ImportPath) || "") + e.Output); text += e.Output; continue; }
      if (e.Action === "build-fail") continue;
      if (e.FailedBuild) failedBuild.set(e.Package, e.FailedBuild);
      if (e.Action === "output") { text += e.Output; out.set(key(e), (out.get(key(e)) || "") + e.Output); }
      else if (["pass", "fail", "skip"].includes(e.Action)) status.set(key(e), e.Action);
    }
    const pkgDir = (pkg) => {
      if (!mod) return "";
      const rel = pkg === mod.mod ? "" : pkg.startsWith(mod.mod + "/") ? pkg.slice(mod.mod.length + 1) : "";
      return relTo(root, mod.dir, rel || ".").replace(/^\.$/, "");
    };
    const c = counts(), failures = [], files = [];
    const failedNames = [...status].filter(([k, v]) => v === "fail" && !k.endsWith("\0")).map(([k]) => k);
    for (const [k, v] of status) {
      const [pkg, test] = k.split("\0");
      if (!test) {
        if (v === "fail" && !failedNames.some((n) => n.startsWith(pkg + "\0"))) { // package-level failure: build error, panic outside a test
          c.fail++;
          const o = strip((build.get(failedBuild.get(pkg) || pkg) || "") + (out.get(k) || ""));
          const msgLines = o.split("\n").filter((l) => l.trim() && !/^(FAIL\b|exit status|#)/.test(l));
          const at = /^([\w./-]+\.go):(\d+)(?::\d+)?:\s*(.*)$/.exec(msgLines[0] || "");
          const dir = pkgDir(pkg);
          failures.push({ name: `(package ${pkg}${failedBuild.has(pkg) ? ": build failed" : ""})`, file: at ? (dir ? dir + "/" : "") + path.basename(at[1]) : dir, line: at ? +at[2] : 0, msg: at ? at[3] : msgLines.slice(0, 6).join("\n"), frame: "" });
        }
        continue;
      }
      if (v === "pass") c.pass++;
      else if (v === "skip") c.skip++;
      else {
        if (failedNames.some((n) => n.startsWith(k + "/"))) continue; // a parent of a failing subtest
        c.fail++;
        const o = strip(out.get(k) || "");
        const loc = /^\s*([\w./-]+\.go):(\d+):\s?(.*)$/m.exec(o);
        const trace = /Error Trace:\s+([\w./-]+\.go):(\d+)/.exec(o);
        const errTxt = /Error:\s+(.*(?:\n\s{8,}.*)*)/.exec(o);
        const panic = /^(panic: .*)$/m.exec(o);
        const dir = pkgDir(pkg), f = (b) => (dir ? dir + "/" : "") + b;
        const lf = trace ? f(path.basename(trace[1])) : loc ? f(path.basename(loc[1])) : dir;
        const ln = trace ? +trace[2] : loc ? +loc[2] : 0;
        const msg = errTxt ? errTxt[1].replace(/\s*\n\s*/g, " ").trim() : panic ? panic[1] : loc ? loc[3].trim() : o.split("\n").filter((l) => l.trim() && !/^(=== |--- |FAIL)/.test(l)).slice(0, 3).join(" | ");
        let frame = "";
        const fr = /\n\s*([\w./-]+\.go):(\d+)[^\n]*\n/.exec(o.replace(/^.*Error Trace.*$/m, "")); // goroutine frame in a panic
        if (panic && fr) frame = `${f(path.basename(fr[1]))}:${fr[2]}`;
        else if (lf) frame = ln ? `${lf}:${ln}` : lf;
        failures.push({ name: test, file: lf, line: ln, msg, frame });
      }
      if (test.indexOf("/") < 0) { const m = /^\s*([\w./-]+_test\.go):\d+/m.exec(out.get(k) || ""); if (m) files.push(path.join(pkgDir(pkg), path.basename(m[1])).split(path.sep).join("/")); }
    }
    // test file names are only known from output lines; add each package's test files from disk
    if (mod) for (const pkg of new Set([...status.keys()].map((k) => k.split("\0")[0]))) {
      try { for (const f of fs.readdirSync(path.join(mod.dir, pkg === mod.mod ? "." : pkg.slice(mod.mod.length + 1)))) if (f.endsWith("_test.go")) files.push((pkgDir(pkg) ? pkgDir(pkg) + "/" : "") + f); } catch { /* package outside the module */ }
    }
    return { ok: true, counts: c, failures, files: uniq(files), text };
  },
};

// ---------- flutter test --machine ----------
const flutter = {
  name: "flutter",
  prepare({ cmd, grep, focus }) {
    if (!/\bflutter\s+test\b/.test(cmd)) throw new Error("adapter flutter needs a command containing 'flutter test'");
    let c = cmd.replace(/\bflutter\s+test\b/, "flutter test --machine");
    if (focus) c += " " + uniq(focus.map((f) => f.file).filter(Boolean)).map(sq).join(" ");
    if (focus && focus.length === 1) c += ` --plain-name ${sq(focus[0].name)}`;
    else if (grep) c += ` --plain-name ${sq(grep)}`;
    return { cmd: c, env: {} };
  },
  parse({ raw, root, cwd }) {
    const suites = new Map(), tests = new Map(), errs = new Map(), prints = new Map();
    let any = false, text = "";
    for (const l of raw.split("\n")) {
      if (l[0] !== "{" && l[0] !== "[") { if (l.trim()) text += l + "\n"; continue; }
      let es; try { es = JSON.parse(l); } catch { text += l + "\n"; continue; }
      for (const e of Array.isArray(es) ? es : [es]) {
        if (!e || !e.type) continue;
        any = true;
        if (e.type === "suite") suites.set(e.suite.id, e.suite.path);
        else if (e.type === "testStart") tests.set(e.test.id, { ...e.test, result: null });
        else if (e.type === "testDone") { const t = tests.get(e.testID); if (t) Object.assign(t, { result: e.result, skipped: e.skipped, hidden: e.hidden }); }
        else if (e.type === "error") { (errs.get(e.testID) || errs.set(e.testID, []).get(e.testID)).push(e); text += `${e.error}\n${e.stackTrace || ""}\n`; }
        else if (e.type === "print") { text += e.message + "\n"; (prints.get(e.testID) || prints.set(e.testID, []).get(e.testID)).push(e.message); }
      }
    }
    if (!any) return { ok: false };
    const c = counts(), failures = [], files = [];
    for (const [id, t] of tests) {
      if (t.hidden || /^loading /.test(t.name)) continue;
      const sp = suites.get(t.suiteID);
      const file = sp ? relTo(root, cwd, sp) : t.url ? relTo(root, cwd, t.url) : "";
      if (file) files.push(file);
      if (t.skipped) c.skip++;
      else if (t.result === "success") c.pass++;
      else if (t.result === "failure" || t.result === "error") {
        c.fail++;
        const e = (errs.get(id) || [])[0] || {};
        const st = String(e.stackTrace || "");
        const m = /([\w./-]+\.dart):(\d+)(?::\d+)?/.exec(st);
        failures.push({ name: t.name, file: file || (m ? relTo(root, cwd, m[1]) : ""), line: t.line || 0, msg: strip(e.error || "").trim(), frame: m ? `${relTo(root, cwd, m[1])}:${m[2]}` : "" });
      }
    }
    return { ok: true, counts: c, failures, files: uniq(files), text };
  },
};

// ---------- generic: tee the output, scan for failure lines ----------
const FAIL_LINE = /(^|\s)(FAIL(ED)?\b|not ok\b|panic:|Traceback \(most recent|AssertionError|✗|✘|×)|^\s*(Error|error)(\[\w+\])?:/;
const generic = {
  name: "generic",
  prepare({ cmd, grep }) {
    if (grep) {
      if (!cmd.includes("{grep}")) throw new Error("--grep needs an adapter that can filter, or {grep} in the command");
    }
    return { cmd, env: {} };
  },
  parse({ raw, exit }) {
    const lines = strip(raw).split("\n").map((l) => l.replace(/\s+$/, ""));
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    const hits = [];
    lines.forEach((l, i) => { if (FAIL_LINE.test(l)) hits.push(i); });
    const failures = [];
    if (exit !== 0) {
      if (hits.length) for (const i of hits.slice(0, 50)) failures.push({ name: lines[i].trim().slice(0, 160), file: "", line: i + 1, msg: "", frame: "", generic: true });
      else failures.push({ name: "(no recognised failure line; last 30 lines of output)", file: "", line: 0, msg: "", frame: "", tail: lines.slice(-30), generic: true });
    }
    return { ok: true, generic: true, counts: { pass: -1, fail: failures.length, skip: -1, flaky: 0 }, failures, files: [] };
  },
};

const ADAPTERS = { vitest, playwright, gotest, flutter, generic };
module.exports = { ADAPTERS, strip, sq, relTo, splitStack, FAIL_LINE };
