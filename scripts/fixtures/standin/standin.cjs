/* Stand-in test runners for fixit's tests: not the real tools. Each one reads
 * cases.json from its working directory and prints the report format of the tool
 * it stands for (vitest, playwright, flutter). vitest and playwright formats were
 * copied from real runs; flutter's --machine format is from its documentation
 * and was never checked against the real tool.
 *
 * cases.json: { "sleepMs": 0, "tests": [ { "file", "name", "status": "pass|fail|skip",
 *   "msg", "line", "frame", "failTimes": N } ] }   failTimes makes a test fail its
 * first N runs (state in $STANDIN_STATE), for flaky-test checks.
 */
"use strict";
const fs = require("fs");
const path = require("path");

module.exports = function run(tool) {
  const args = process.argv.slice(2);
  const cases = JSON.parse(fs.readFileSync("cases.json", "utf8"));
  const flag = (n) => { const i = args.findIndex((a) => a === n || a.startsWith(n + "=")); if (i < 0) return null; return args[i].includes("=") ? args[i].slice(n.length + 1) : args[i + 1]; };
  const grep = flag("-t") || flag("--grep") || flag("--plain-name");
  const positional = args.filter((a, i) => !a.startsWith("-") && !["-t", "--grep", "--plain-name"].includes(args[i - 1]) && !["run", "test"].includes(a) && /[/.]/.test(a));
  const files = positional.map((p) => p.replace(/:\d+$/, ""));
  const stateDir = process.env.STANDIN_STATE || require("os").tmpdir();
  const bump = (name) => { const f = path.join(stateDir, "standin-" + Buffer.from(process.cwd() + name).toString("hex").slice(-40)); let n = 0; try { n = +fs.readFileSync(f, "utf8"); } catch { /* first run */ } fs.writeFileSync(f, String(n + 1)); return n; };
  let tests = cases.tests.filter((t) => (!files.length || files.some((f) => t.file === f || t.file.endsWith("/" + f))) && (!grep || t.name.includes(grep)));
  tests = tests.map((t) => { let st = t.status; if (st === "pass" && t.failTimes && bump(t.name) < t.failTimes) st = "fail"; return { ...t, st }; });
  if (cases.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, cases.sleepMs);
  const bad = tests.filter((t) => t.st === "fail");
  const cwd = process.cwd();

  if (tool === "vitest") {
    const out = flag("--outputFile.json");
    const byFile = new Map();
    for (const t of tests) { if (!byFile.has(t.file)) byFile.set(t.file, []); byFile.get(t.file).push(t); }
    const report = {
      numTotalTests: tests.length, numPassedTests: tests.filter((t) => t.st === "pass").length, numFailedTests: bad.length, numPendingTests: tests.filter((t) => t.st === "skip").length, success: !bad.length,
      testResults: [...byFile].map(([file, ts]) => ({ name: path.join(cwd, file), status: ts.some((t) => t.st === "fail") ? "failed" : "passed", assertionResults: ts.map((t) => ({
        ancestorTitles: t.name.split(" ").slice(0, 1), fullName: t.name, title: t.name, status: t.st === "pass" ? "passed" : t.st === "fail" ? "failed" : "skipped",
        failureMessages: t.st === "fail" ? [`AssertionError: ${t.msg || "failed"}\n    at ${path.join(cwd, file)}:${t.line || 1}:10\n    at file://${cwd}/node_modules/vitest/dist/run.js:100:20`] : [] })) })),
    };
    if (out) fs.writeFileSync(out, JSON.stringify(report));
    for (const t of bad) console.log(` FAIL  ${t.file} > ${t.name}\nAssertionError: ${t.msg}`);
    console.log(` Tests  ${bad.length} failed | ${report.numPassedTests} passed`);
  } else if (tool === "playwright") {
    const out = process.env.PLAYWRIGHT_JSON_OUTPUT_NAME;
    const byFile = new Map();
    for (const t of tests) { if (!byFile.has(t.file)) byFile.set(t.file, []); byFile.get(t.file).push(t); }
    const suites = [...byFile].map(([file, ts]) => ({ title: path.basename(file), file: path.basename(file), column: 0, line: 0, specs: ts.map((t) => ({ title: t.name, ok: t.st !== "fail", tags: [], file: path.basename(file), line: t.line || 1, column: 1, tests: [{ expectedStatus: "passed", projectName: "", results: [t.st === "fail" ? { status: "failed", error: { message: `Error: ${t.msg}`, stack: `Error: ${t.msg}\n    at ${path.join(cwd, file)}:${t.line || 1}:5`, location: { file: path.join(cwd, file), line: t.line || 1, column: 5 } } } : { status: t.st === "skip" ? "skipped" : "passed" }], status: t.st === "fail" ? "unexpected" : t.st === "skip" ? "skipped" : "expected" }] })), suites: [] }));
    if (out) fs.writeFileSync(out, JSON.stringify({ config: { rootDir: cwd, projects: [{ testDir: cwd }] }, suites, stats: { expected: tests.filter((t) => t.st === "pass").length, unexpected: bad.length, skipped: tests.filter((t) => t.st === "skip").length, flaky: 0 } }));
    tests.forEach((t, i) => console.log(`  ${t.st === "pass" ? "ok" : t.st === "fail" ? "x" : "-"}  ${i + 1} ${t.file}:${t.line || 1} › ${t.name}`));
    for (const t of bad) console.log(`\n  Error: ${t.msg}\n    at ${path.join(cwd, t.file)}:${t.line || 1}:5`);
  } else if (tool === "flutter") {
    const ev = [{ type: "start", protocolVersion: "0.1.1" }];
    const suites = [...new Set(tests.map((t) => t.file))];
    suites.forEach((f, i) => ev.push({ type: "suite", suite: { id: i, platform: "vm", path: path.join(cwd, f) } }));
    tests.forEach((t, i) => {
      const id = i + 1, sid = suites.indexOf(t.file);
      ev.push({ type: "testStart", test: { id, name: t.name, suiteID: sid, groupIDs: [], metadata: { skip: t.st === "skip" }, line: t.line || 1, column: 1, url: "file://" + path.join(cwd, t.file) } });
      if (t.st === "fail") ev.push({ type: "error", testID: id, error: t.msg, stackTrace: `package:sample/${t.file}:${t.line || 1}:5\n`, isFailure: true });
      ev.push({ type: "testDone", testID: id, result: t.st === "fail" ? "failure" : "success", skipped: t.st === "skip", hidden: false });
    });
    ev.push({ type: "done", success: !bad.length });
    for (const e of ev) console.log(JSON.stringify(e));
  }
  process.exitCode = bad.length ? 1 : 0;
};
