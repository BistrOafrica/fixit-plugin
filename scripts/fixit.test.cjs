// node --test scripts/fixit.test.cjs
// Stand-in runners (scripts/fixtures/standin) print the formats of vitest, playwright and flutter; they are not
// the real tools. The go sample runs against the real `go` and is skipped when it is missing.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const { treeState } = require("./fixit.cjs");
const { kindOf } = require("../skills/remedy/scripts/usage.cjs");

const PLUGIN = path.resolve(__dirname, "..");
const FIXIT = path.join(__dirname, "fixit.cjs");
const REMEDY = path.join(PLUGIN, "skills/remedy/scripts/remedy.cjs");
const STANDIN = path.join(__dirname, "fixtures", "standin");
const GIT = ["-c", "user.email=t@example.com", "-c", "user.name=t"];
const hasGo = cp.spawnSync("go", ["version"]).status === 0;
const tmp = (p = "fixit-") => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), p));
const git = (cwd, ...a) => { const r = cp.spawnSync("git", [...GIT, ...a], { cwd, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const cleanups = [];
test.after(() => { for (const f of cleanups) try { f(); } catch { /* best effort */ } });

// A throwaway git repo, with the stand-in runners on PATH and a fixit.config.json.
function repo(config, cases, extra = {}) {
  const root = tmp();
  git(root, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, "fixit.config.json"), JSON.stringify(config));
  fs.writeFileSync(path.join(root, "cases.json"), JSON.stringify(cases));
  for (const [f, text] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), text); }
  git(root, "add", "-A"); git(root, "commit", "-qm", "init");
  const state = tmp("fixit-state-");
  const env = { ...process.env, PATH: STANDIN + path.delimiter + process.env.PATH, STANDIN_STATE: state, FIXIT_LOCK_POLL_MS: "50" };
  delete env.FIXIT_DIR;
  const r = {
    root, env,
    run: (args, o = {}) => { const x = cp.spawnSync(process.execPath, [FIXIT, ...args], { cwd: o.cwd || root, encoding: "utf8", env: { ...env, ...(o.env || {}) }, timeout: 60000 }); return { code: x.status, out: x.stdout, err: x.stderr }; },
    runs: () => { try { return fs.readdirSync(path.join(root, ".fixit", "runs")).sort(); } catch { return []; } },
    meta: (id) => JSON.parse(fs.readFileSync(path.join(root, ".fixit", "runs", id, "meta.json"), "utf8")),
    cases: (c) => fs.writeFileSync(path.join(root, "cases.json"), JSON.stringify(c)),
    commit: (m = "c") => { git(root, "add", "-A"); git(root, "commit", "-qm", m); },
  };
  cleanups.push(() => { for (const id of r.runs()) { try { const m = r.meta(id); if (m.pid) process.kill(m.pid, "SIGKILL"); } catch { /* gone */ } } fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); });
  return r;
}
const lines = (s) => s.replace(/\n$/, "").split("\n");
const UNIT = { lanes: { unit: { cmd: "vitest run", adapter: "vitest" } } };
const T = (file, name, status = "pass", more = {}) => ({ file, name, status, ...more });
const CART_FAIL = { tests: [T("tests/cart.test.ts", "cart adds"), T("tests/cart.test.ts", "cart totals", "fail", { msg: "expected 6 to equal 7", line: 12 }), T("tests/cart.test.ts", "cart later", "skip")] };

test("a failing test returns its assertion in a digest of at most 40 lines; every run is saved", () => {
  const r = repo(UNIT, CART_FAIL);
  const x = r.run(["test", "unit"]);
  assert.equal(x.code, 1);
  const l = lines(x.out);
  assert.ok(l.length <= 40);
  assert.match(l[0], /^fixit test unit  sha [0-9a-f]{7}  [\d.]+s  \(ran: vitest run\)$/);
  assert.equal(l[1], "pass 1  fail 1  skip 1  flaky 0");
  assert.equal(l[2], "FAIL tests/cart.test.ts:12 cart totals");
  assert.match(l[3], /^ {2}AssertionError: expected 6 to equal 7/);
  assert.match(l[l.length - 1], /^run \d{8}-\d{6}-\d{3}$/);
  const [id] = r.runs(), dir = path.join(r.root, ".fixit", "runs", id);
  for (const f of ["raw.log", "report.json", "meta.json", "digest.txt", "digest-full.txt"]) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.equal(fs.readFileSync(path.join(dir, "digest.txt"), "utf8"), x.out);
});

test("a passing run saves its full output and exits 0", () => {
  const r = repo(UNIT, { tests: [T("tests/a.test.ts", "a works")] });
  const x = r.run(["test", "unit"]);
  assert.equal(x.code, 0);
  assert.equal(lines(x.out)[1], "pass 1  fail 0  skip 0  flaky 0");
  const [id] = r.runs();
  assert.match(fs.readFileSync(path.join(r.root, ".fixit", "runs", id, "raw.log"), "utf8"), /Tests {2}0 failed \| 1 passed/);
  assert.equal(r.meta(id).exitCode, 0);
  assert.equal(r.meta(id).result, "pass");
});

test("cache: an unchanged tree prints already green and runs nothing; a one-line edit runs again", () => {
  const r = repo(UNIT, { tests: [T("tests/a.test.ts", "a works")] }, { "src/a.ts": "export const a = 1;\nexport const b = 2;\n" });
  assert.equal(r.run(["test", "unit"]).code, 0);
  const again = r.run(["test", "unit"]);
  assert.match(again.out, /^fixit test unit: already green at [0-9a-f]{7} \(run \d{8}/);
  assert.equal(r.runs().length, 1, "nothing ran");
  fs.writeFileSync(path.join(r.root, "src/a.ts"), "export const a = 1;\nexport const b = 3;\n");
  const edited = r.run(["test", "unit"]);
  assert.match(edited.out, /^fixit test unit {2}sha [0-9a-f]{7}\+dirty/);
  assert.equal(r.runs().length, 2);
  assert.match(r.run(["test", "unit"]).out, /already green at [0-9a-f]{7}\+dirty/, "a dirty tree is cached too");
  assert.equal(r.run(["test", "unit", "--no-cache"]).code, 0);
  assert.equal(r.runs().length, 3);
  const cacheless = repo({ lanes: { unit: { cmd: "vitest run", adapter: "vitest", cacheable: false } } }, { tests: [T("tests/a.test.ts", "x")] });
  cacheless.run(["test", "unit"]); cacheless.run(["test", "unit"]);
  assert.equal(cacheless.runs().length, 2, "cacheable:false always runs");
});

test("cache key: a run's own files cannot change it, an edit or a new untracked file does", () => {
  const r = repo(UNIT, { tests: [T("tests/a.test.ts", "x")] }, { "src/a.ts": "one\ntwo\n" });
  const k0 = treeState(r.root).hash;
  for (const f of [".fixit/runs/x/raw.log", ".fixit/cache.json", ".remedy/items/A-1.json", ".remedy/meta.json"]) { fs.mkdirSync(path.dirname(path.join(r.root, f)), { recursive: true }); fs.writeFileSync(path.join(r.root, f), "data " + f); }
  assert.equal(treeState(r.root).hash, k0, ".fixit and .remedy are ignored");
  assert.equal(treeState(r.root).dirty, false);
  fs.writeFileSync(path.join(r.root, "src/a.ts"), "one\nTWO\n");
  const k1 = treeState(r.root).hash;
  assert.notEqual(k1, k0, "a one-line edit changes it");
  fs.writeFileSync(path.join(r.root, "src/new.ts"), "x");
  assert.notEqual(treeState(r.root).hash, k1, "an untracked file changes it");
  fs.writeFileSync(path.join(r.root, "src/a.ts"), "one\ntwo\n");
  fs.rmSync(path.join(r.root, "src/new.ts"));
  assert.equal(treeState(r.root).hash, k0, "undoing the edit restores it");
});

test("the second identical failure prints STOP and exits 3; a pass clears the count", () => {
  const r = repo(UNIT, CART_FAIL);
  const a = r.run(["test", "unit", "--no-cache"]);
  assert.equal(a.code, 1); assert.doesNotMatch(a.out, /STOP/);
  const b = r.run(["test", "unit", "--no-cache"]);
  assert.equal(b.code, 3);
  const [r1, r2] = r.runs();
  assert.match(b.out, new RegExp(`STOP: same failure twice \\(runs ${r1}, ${r2}\\)\\. Write your report and return\\.`));
  assert.ok(lines(b.out).length <= 40);
  // a different message is a different failure
  r.cases({ tests: [T("tests/cart.test.ts", "cart totals", "fail", { msg: "expected null to equal 7", line: 12 })] });
  assert.equal(r.run(["test", "unit", "--no-cache"]).code, 1);
  // a pass clears
  r.cases({ tests: [T("tests/cart.test.ts", "cart totals")] });
  assert.equal(r.run(["test", "unit", "--no-cache"]).code, 0);
  r.cases(CART_FAIL);
  assert.equal(r.run(["test", "unit", "--no-cache"]).code, 1, "count restarted");
});

// The count behind STOP is per worktree and failure signature, however the test was run.
const CART_LANES = { lanes: { unit: { cmd: "vitest run", adapter: "vitest", paths: ["tests/"] }, other: { cmd: "vitest run", adapter: "vitest", paths: ["docs/"] } }, fileRules: [{ suffix: ".test.ts", cmd: "vitest run {file}", adapter: "vitest" }] };
const OTHER_PASS = { tests: [T("tests/other.test.ts", "other ok")] };
test("STOP: the same failure twice stops whichever way it was run: file, then lane, then --changed", () => {
  const extra = { "tests/cart.test.ts": "// the stand-in reads cases.json\n" };
  const r = repo(CART_LANES, CART_FAIL, extra);
  assert.equal(r.run(["test", "tests/cart.test.ts", "--no-cache"]).code, 1);
  const b = r.run(["test", "unit", "--no-cache"]);
  assert.equal(b.code, 3, "a file run then a lane run");
  assert.match(b.out, /STOP: same failure twice/);
  const q = repo(CART_LANES, CART_FAIL, extra);
  assert.equal(q.run(["test", "tests/cart.test.ts", "--no-cache"]).code, 1);
  fs.appendFileSync(path.join(q.root, "tests/cart.test.ts"), "// touched\n");
  assert.equal(q.run(["test", "--changed", "--no-cache"]).code, 3, "a file run then --changed");
  assert.equal(q.run(["test", "tests/cart.test.ts", "--no-cache"]).code, 3, "and back");
});

test("STOP: a pass of the same lane or file clears the count; a pass of something unrelated does not", () => {
  const extra = { "tests/cart.test.ts": "// x\n", "tests/other.test.ts": "// y\n" };
  const r = repo(CART_LANES, CART_FAIL, extra);
  assert.equal(r.run(["test", "tests/cart.test.ts", "--no-cache"]).code, 1);
  r.cases(OTHER_PASS); // the other lane reports only tests/other.test.ts, and it passes
  assert.equal(r.run(["test", "other", "--no-cache"]).code, 0);
  r.cases(CART_FAIL);
  assert.equal(r.run(["test", "tests/cart.test.ts", "--no-cache"]).code, 3, "the unrelated pass left the count alone");
  // A lane that reports the failing file and passes it clears the count, even though the failure was seen by file run.
  r.cases({ tests: [T("tests/cart.test.ts", "cart totals")] });
  assert.equal(r.run(["test", "unit", "--no-cache"]).code, 0);
  r.cases(CART_FAIL);
  assert.equal(r.run(["test", "tests/cart.test.ts", "--no-cache"]).code, 1, "count restarted");
  // The same file passing clears it too.
  r.cases({ tests: [T("tests/cart.test.ts", "cart totals")] });
  assert.equal(r.run(["test", "tests/cart.test.ts", "--no-cache"]).code, 0);
  r.cases(CART_FAIL);
  assert.equal(r.run(["test", "tests/cart.test.ts", "--no-cache"]).code, 1, "count restarted again");
});

test("STOP: a --grep run of another test in the same file does not clear the count", () => {
  const r = repo(CART_LANES, CART_FAIL, { "tests/cart.test.ts": "// x\n" });
  assert.equal(r.run(["test", "tests/cart.test.ts", "--no-cache"]).code, 1);
  r.cases({ tests: [T("tests/cart.test.ts", "cart empty")] });
  assert.equal(r.run(["test", "tests/cart.test.ts", "--grep", "cart empty", "--no-cache"]).code, 0);
  r.cases(CART_FAIL);
  assert.equal(r.run(["test", "tests/cart.test.ts", "--no-cache"]).code, 3);
});

test("STOP: parallel worktrees do not trip each other, and a file outside the checkout is refused", () => {
  const r = repo(CART_LANES, CART_FAIL, { "tests/cart.test.ts": "// x\n" });
  const a = path.join(r.root, ".fixit-wt-a"), b = path.join(r.root, ".fixit-wt-b");
  git(r.root, "worktree", "add", "-q", a, "-b", "wt-a"); git(r.root, "worktree", "add", "-q", b, "-b", "wt-b");
  assert.equal(r.run(["test", "unit", "--no-cache"], { cwd: a }).code, 1);
  assert.equal(r.run(["test", "unit", "--no-cache"], { cwd: b }).code, 1, "the same failure in another worktree is its first");
  assert.equal(r.run(["test", "unit", "--no-cache"], { cwd: a }).code, 3, "the second in its own");
  assert.equal(r.run(["test", "unit", "--no-cache"]).code, 1, "the main checkout has its own count");
  const out = r.run(["test", "../../" + path.basename(os.tmpdir()) + "/x.test.ts"]);
  assert.equal(out.code, 2);
  fs.writeFileSync(path.join(path.dirname(r.root), "outside-" + path.basename(r.root) + ".test.ts"), "// x\n");
  const o = r.run(["test", "../outside-" + path.basename(r.root) + ".test.ts"]);
  assert.equal(o.code, 2); assert.match(o.err, /outside this checkout/);
  fs.rmSync(path.join(path.dirname(r.root), "outside-" + path.basename(r.root) + ".test.ts"));
});

test("a failure that passes on --repeat 1 is flaky; both logs are kept; flakes do not count towards STOP", () => {
  const r = repo(UNIT, { tests: [T("tests/a.test.ts", "a sometimes", "pass", { failTimes: 1, msg: "timed out after 5 ms", line: 3 }), T("tests/a.test.ts", "a steady")] });
  const x = r.run(["test", "unit", "--repeat", "1", "--no-cache"]);
  assert.equal(x.code, 0, x.out);
  assert.match(x.out, /^FLAKY tests\/a\.test\.ts:3 "a sometimes": passed on repeat; both logs kept$/m);
  assert.match(x.out, /flaky 1/);
  const [id] = r.runs(), dir = path.join(r.root, ".fixit", "runs", id);
  assert.ok(fs.existsSync(path.join(dir, "raw.log")) && fs.existsSync(path.join(dir, "repeat-1.log")));
  assert.match(fs.readFileSync(path.join(dir, "raw.log"), "utf8"), /FAIL/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "repeat-1.log"), "utf8"), /FAIL/);
  assert.equal(r.meta(id).result, "flaky");
  // without --repeat the same test is just a failure
  const r2 = repo(UNIT, { tests: [T("tests/a.test.ts", "a sometimes", "pass", { failTimes: 1, msg: "boom" })] });
  assert.equal(r2.run(["test", "unit"]).code, 1);
  // still failing after the repeat: a failure, not a flake
  const r3 = repo(UNIT, CART_FAIL);
  const y = r3.run(["test", "unit", "--repeat", "1"]);
  assert.equal(y.code, 1); assert.doesNotMatch(y.out, /FLAKY/);
});

test("--bg then wait works; wait gives up politely and nothing is left running", () => {
  const r = repo({ lanes: { slow: { cmd: "vitest run", adapter: "vitest" } } }, { sleepMs: 1500, tests: [T("tests/a.test.ts", "a works")] });
  const s = r.run(["test", "slow", "--bg"]);
  assert.equal(s.code, 0);
  const id = /^started (\S+)/.exec(s.out)[1];
  assert.match(s.out, new RegExp(`fixit wait ${id}`));
  const pid = r.meta(id).pid;
  const early = r.run(["wait", id, "--timeout", "0"]);
  assert.match(early.out, new RegExp(`^running {2}${id}`));
  const done = r.run(["wait", id, "--timeout", "30"]);
  assert.equal(done.code, 0);
  assert.match(done.out, /pass 1 {2}fail 0/);
  assert.equal(r.meta(id).status, "pass");
  assert.throws(() => process.kill(pid, 0), "the background process has exited");
  // "bg": true in the config does the same, and a prefix of the id is enough
  const r2 = repo({ lanes: { slow: { cmd: "vitest run", adapter: "vitest", bg: true } } }, { sleepMs: 200, tests: [T("tests/a.test.ts", "a")] });
  const id2 = /^started (\S+)/.exec(r2.run(["test", "slow"]).out)[1];
  assert.match(r2.run(["wait", id2.slice(0, 12), "--timeout", "30"]).out, /pass 1/);
});

test("a background run that dies is reported, not waited on forever", () => {
  const r = repo({ lanes: { slow: { cmd: "vitest run", adapter: "vitest" } } }, { sleepMs: 20000, tests: [T("tests/a.test.ts", "a")] });
  const id = /^started (\S+)/.exec(r.run(["test", "slow", "--bg"]).out)[1];
  for (let i = 0; i < 100 && r.meta(id).status !== "running"; i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  const pid = r.meta(id).pid;
  process.kill(pid, "SIGKILL");
  const w = r.run(["wait", id, "--timeout", "10"]);
  assert.equal(w.code, 2);
  assert.match(w.out, /died without finishing/);
  try { process.kill(-pid, "SIGKILL"); } catch { /* the stand-in is gone */ }
});

test("--failed runs only the last failures", () => {
  const r = repo(UNIT, { tests: [T("tests/a.test.ts", "a ok"), T("tests/b.test.ts", "b one", "fail", { msg: "expected 1 to equal 2", line: 5 }), T("tests/b.test.ts", "b two")] });
  assert.equal(r.run(["test", "unit"]).code, 1);
  const x = r.run(["test", "unit", "--failed"]);
  assert.equal(x.code, 3, "the same failure again is STOP");
  assert.equal(lines(x.out)[1], "pass 0  fail 1  skip 0  flaky 0", "only the failing test ran");
  const ids = r.runs();
  assert.match(fs.readFileSync(path.join(r.root, ".fixit", "runs", ids[1], "raw.log"), "utf8"), /b one/);
  assert.doesNotMatch(fs.readFileSync(path.join(r.root, ".fixit", "runs", ids[1], "raw.log"), "utf8"), /a ok/);
  assert.equal(r.run(["test", "--failed"]).code, 3, "no target: the newest run; the same failure a third time");
  r.cases({ tests: [T("tests/b.test.ts", "b one")] });
  assert.equal(r.run(["test", "unit"]).code, 0);
  assert.match(r.run(["test", "unit", "--failed"]).out, /had no failures; nothing to re-run/);
  assert.equal(repo(UNIT, { tests: [] }).run(["test", "unit", "--failed"]).code, 2);
});

test("a lane with lock waits for the holder, in the main checkout's .fixit/locks", () => {
  const r = repo({ lanes: { stack: { cmd: "vitest run", adapter: "vitest", lock: "stack", cacheable: false } } }, { sleepMs: 1200, tests: [T("tests/a.test.ts", "a")] });
  const id1 = /^started (\S+)/.exec(r.run(["test", "stack", "--bg"]).out)[1];
  for (let i = 0; i < 100 && !fs.existsSync(path.join(r.root, ".fixit", "locks", "stack.lock")); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  const holder = JSON.parse(fs.readFileSync(path.join(r.root, ".fixit", "locks", "stack.lock"), "utf8"));
  assert.equal(holder.run, id1);
  const id2 = /^started (\S+)/.exec(r.run(["test", "stack", "--bg"]).out)[1];
  let sawWaiting = false;
  for (let i = 0; i < 40 && !sawWaiting; i++) { sawWaiting = r.meta(id2).status === "waiting"; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  assert.ok(sawWaiting, "the second run waits");
  assert.match(r.run(["wait", id2, "--timeout", "0"]).out, /waiting for lock/);
  assert.equal(r.run(["wait", id1, "--timeout", "30"]).code, 0);
  assert.equal(r.run(["wait", id2, "--timeout", "30"]).code, 0);
  const m1 = r.meta(id1), m2 = r.meta(id2);
  assert.ok(Date.parse(m2.startedAt) >= Date.parse(m1.endedAt), "the second started after the first ended");
  assert.ok(!fs.existsSync(path.join(r.root, ".fixit", "locks", "stack.lock")), "released");
  // a stale lock from a dead process is taken over
  fs.mkdirSync(path.join(r.root, ".fixit", "locks"), { recursive: true });
  fs.writeFileSync(path.join(r.root, ".fixit", "locks", "stack.lock"), JSON.stringify({ pid: 2 ** 22 - 3, run: "gone", at: "x" }));
  assert.equal(r.run(["test", "stack"]).code, 0);
});

test("a lock that stays held gives up with exit 2 and runs nothing", () => {
  const r = repo({ lanes: { stack: { cmd: "vitest run", adapter: "vitest", lock: "stack", cacheable: false } } }, { tests: [T("tests/a.test.ts", "a")] });
  fs.mkdirSync(path.join(r.root, ".fixit", "locks"), { recursive: true });
  fs.writeFileSync(path.join(r.root, ".fixit", "locks", "stack.lock"), JSON.stringify({ pid: process.pid, run: "other", at: "x" }));
  const x = r.run(["test", "stack"], { env: { FIXIT_LOCK_WAIT_SEC: "1" } });
  assert.equal(x.code, 2);
  assert.match(x.out, /lock "stack" still held by run other/);
});

test("a worktree uses the main checkout's .fixit; .fixit/.gitignore holds *", () => {
  const r = repo(UNIT, { tests: [T("tests/a.test.ts", "a")] });
  const wt = tmp("fixit-wt-");
  fs.rmSync(wt, { recursive: true });
  git(r.root, "worktree", "add", "-q", "-b", "side", wt);
  cleanups.push(() => fs.rmSync(wt, { recursive: true, force: true }));
  const x = r.run(["test", "unit"], { cwd: wt });
  assert.equal(x.code, 0, x.out + x.err);
  assert.equal(r.runs().length, 1);
  assert.ok(!fs.existsSync(path.join(wt, ".fixit")), "nothing in the worktree");
  assert.equal(fs.readFileSync(path.join(r.root, ".fixit", ".gitignore"), "utf8"), "*\n");
  assert.equal(git(r.root, "status", "--porcelain"), "", ".fixit never shows in git status");
  assert.equal(r.meta(r.runs()[0]).root, wt);
  // an existing .gitignore is left alone
  fs.writeFileSync(path.join(r.root, ".fixit", ".gitignore"), "*\n# mine\n");
  r.run(["test", "unit", "--no-cache"], { cwd: wt });
  assert.match(fs.readFileSync(path.join(r.root, ".fixit", ".gitignore"), "utf8"), /# mine/);
});

test("playwright and flutter stand-ins: digests carry the assertion and file:line", () => {
  const cfg = { lanes: { e2e: { cmd: "playwright test", adapter: "playwright" }, dart: { cmd: "flutter test", adapter: "flutter" } } };
  const r = repo(cfg, { tests: [T("e2e/cart.spec.ts", "cart adds"), T("e2e/cart.spec.ts", "cart totals", "fail", { msg: "Expected: 4, Received: 3", line: 9 }), T("e2e/cart.spec.ts", "cart later", "skip")] });
  const p = r.run(["test", "e2e"]);
  assert.equal(p.code, 1);
  assert.equal(lines(p.out)[1], "pass 1  fail 1  skip 1  flaky 0");
  assert.match(p.out, /FAIL cart\.spec\.ts:9 cart totals|FAIL e2e\/cart\.spec\.ts:9 cart totals/);
  assert.match(p.out, /Error: Expected: 4, Received: 3/);
  r.cases({ tests: [T("test/cart_test.dart", "Cart adds"), T("test/cart_test.dart", "Cart totals", "fail", { msg: "Expected: <4>\n  Actual: <3>", line: 14 })] });
  const f = r.run(["test", "dart"]);
  assert.equal(f.code, 1);
  assert.equal(lines(f.out)[1], "pass 1  fail 1  skip 0  flaky 0");
  assert.match(f.out, /FAIL test\/cart_test\.dart:14 Cart totals\n {2}Expected: <4> \| Actual: <3>/);
});

test("generic adapter: failure lines are scanned; with none, the last lines are shown; a missing command is exit 2", () => {
  const r = repo({ lanes: { make: { cmd: "sh check.sh", adapter: "generic", cacheable: false }, tail: { cmd: "sh quiet.sh", adapter: "generic" }, nope: { cmd: "no-such-tool-xyz --go", adapter: "generic" } } }, { tests: [] },
    { "check.sh": "echo start\necho 'FAIL: widget count'\necho 'not ok 3 - gadget'\nexit 1\n", "quiet.sh": "i=1; while [ $i -le 50 ]; do echo line $i; i=$((i+1)); done; exit 4\n" });
  const a = r.run(["test", "make"]);
  assert.equal(a.code, 1);
  assert.match(a.out, /FAIL FAIL: widget count/); assert.match(a.out, /FAIL not ok 3 - gadget/);
  const b = r.run(["test", "tail"]);
  assert.equal(b.code, 1);
  assert.ok(lines(b.out).length <= 40);
  assert.match(b.out, /line 50/); assert.doesNotMatch(b.out, /line 10\n/);
  const c = r.run(["test", "nope"]);
  assert.equal(c.code, 2);
  assert.match(c.out, /could not run \(exit 127\)/);
  assert.equal(r.run(["test", "make", "--grep", "x"]).code, 2, "generic cannot filter");
});

test("many failures: at most 40 lines of at most 200 characters; identical failures group; overflow points to digest-full", () => {
  const tests = [];
  for (let i = 0; i < 30; i++) tests.push(T(`tests/many.test.ts`, `case number ${i}`, "fail", { msg: `expected ${i} to equal ${i + 1000} ${"x".repeat(300)}`, line: i + 1 }));
  for (let i = 0; i < 4; i++) tests.push(T("tests/same.test.ts", "same", "fail", { msg: "oops 7", line: 3 }));
  const r = repo(UNIT, { tests });
  const x = r.run(["test", "unit"]);
  const l = lines(x.out);
  assert.ok(l.length <= 40, `${l.length} lines`);
  assert.ok(l.every((s) => s.length <= 200));
  assert.match(x.out, /^\d+ further failures in \.fixit\/runs\/\S+\/digest-full\.txt$/m);
  const [id] = r.runs();
  const full = fs.readFileSync(path.join(r.root, ".fixit", "runs", id, "digest-full.txt"), "utf8");
  assert.equal((full.match(/^FAIL/gm) || []).length, 31, "30 distinct plus one group of 4");
  const sameOnly = repo(UNIT, { tests: tests.slice(30) });
  assert.match(sameOnly.run(["test", "unit"]).out, /FAIL \(x4\) tests\/same\.test\.ts:3 same/);
  // show: the whole list, capped at 80 lines, and one test in full
  const s = r.run(["show", id]);
  assert.ok(lines(s.out).length <= 82); assert.match(s.out, /sed -n '81,\d+p'/);
  const one = r.run(["show", id, "--test", "case number 7"]);
  assert.match(one.out, /FAIL tests\/many\.test\.ts:8 case number 7/); assert.match(one.out, /expected 7 to equal 1007/);
  assert.equal(r.run(["show", "last", "--test", "no such"]).code, 2);
});

test("timeouts kill the process group; clean removes old runs and stale locks", () => {
  const r = repo({ lanes: { hang: { cmd: "sh hang.sh", adapter: "generic", timeoutSec: 1 } } }, { tests: [] }, { "hang.sh": "sleep 30 &\necho $! > .child\nwait\n" });
  const x = r.run(["test", "hang"], { env: { FIXIT_TIMEOUT_SEC: "1" } });
  assert.equal(x.code, 1);
  assert.match(x.out, /timed out after 1s/);
  const child = +fs.readFileSync(path.join(r.root, ".child"), "utf8");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  assert.throws(() => process.kill(child, 0), "no leftover process");
  assert.equal(r.runs().length, 1);
  fs.mkdirSync(path.join(r.root, ".fixit", "locks"), { recursive: true });
  fs.writeFileSync(path.join(r.root, ".fixit", "locks", "old.lock"), JSON.stringify({ pid: 2 ** 22 - 3 }));
  assert.match(r.run(["clean", "--days", "30"]).out, /removed 0 runs.*1 stale lock; 1 kept/);
  const c = r.run(["clean", "--days", "0"]);
  assert.match(c.out, /removed 1 run /);
  assert.equal(r.runs().length, 0);
});

test("--changed maps changed files to lanes through paths, and to same-named test files", () => {
  const cfg = { lanes: { api: { cmd: "vitest run", adapter: "vitest", paths: ["api/"] }, web: { cmd: "vitest run", adapter: "vitest", paths: ["web/"] } } };
  const r = repo(cfg, { tests: [T("tests/a.test.ts", "a"), T("src/util.test.ts", "util")] }, { "api/x.ts": "1\n", "web/y.ts": "1\n", "src/util.ts": "1\n", "src/util.test.ts": "t\n", "tests/a.test.ts": "t\n" });
  assert.match(r.run(["test", "--changed"]).out, /no changed files map/);
  fs.writeFileSync(path.join(r.root, "api/x.ts"), "2\n");
  fs.writeFileSync(path.join(r.root, "src/util.ts"), "2\n");
  const x = r.run(["test", "--changed"]);
  assert.equal(x.code, 0, x.out);
  const labels = r.runs().map((id) => r.meta(id).label);
  assert.ok(labels.includes("api") && !labels.includes("web"), labels.join());
  assert.ok(labels.some((l) => l.startsWith("changed:vitest:")), "src/util.test.ts runs for src/util.ts");
  assert.ok(lines(x.out).length <= 40);
});

test("a file argument uses the adapter its suffix implies; bad usage is exit 2", () => {
  const r = repo({}, { tests: [T("tests/a.test.ts", "a ok"), T("tests/b.test.ts", "b bad", "fail", { msg: "no", line: 2 })] }, { "tests/a.test.ts": "x", "tests/b.test.ts": "x" });
  const a = r.run(["test", "tests/a.test.ts"]);
  assert.equal(a.code, 0, a.out + a.err);
  assert.match(a.out, /pass 1 {2}fail 0/);
  const b = r.run(["test", "tests/b.test.ts", "--grep", "b bad"]);
  assert.equal(b.code, 1);
  assert.match(b.out, /FAIL tests\/b\.test\.ts:2 b bad/);
  assert.equal(r.meta(r.runs()[0]).target, "tests/a.test.ts");
  assert.equal(r.run(["test", "nope"]).code, 2);
  assert.equal(r.run(["test"]).code, 2);
  assert.equal(r.run(["test", "x", "--repeat", "z"]).code, 2);
  assert.equal(r.run(["bogus"]).code, 2);
  assert.equal(r.run(["wait", "nosuchrun"]).code, 2);
});

test("--cmd is refused and runs nothing, so an allow rule for fixit cannot run an arbitrary command", () => {
  const r = repo({}, { tests: [] });
  const marker = path.join(r.root, "ran");
  for (const args of [["test", "--cmd", `touch ${marker}`], ["test", `--cmd=touch ${marker}`], ["test", "--cmd", `touch ${marker}`, "--adapter", "generic"], ["test", "unit", "--cmd", `touch ${marker}`], ["logs", "--cmd", `touch ${marker}`], ["logs", `--cmd=touch ${marker}`], ["logs", "file:x", "--cmd", `touch ${marker}`], ["test", "--cmd"], ["logs", "--cmd"]]) {
    const x = r.run(args);
    assert.equal(x.code, 2, args.join(" "));
    assert.match(x.err, /--cmd/, args.join(" "));
  }
  assert.equal(fs.existsSync(marker), false);
});

test("a lane with an unknown adapter is a usage error", () => {
  const r = repo({ lanes: { x: { cmd: "true", adapter: "nonsense" } } }, { tests: [] });
  assert.equal(r.run(["test", "x"]).code, 2);
});

test("a go test file runs as its package, from the module holding it, by file, by fileRules and by --changed", { skip: !hasGo && "go is not installed" }, () => {
  const root = tmp("fixit-gomod-");
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(__dirname, "fixtures", "go-sample"), path.join(root, "svc"), { recursive: true });
  git(root, "init", "-q", "-b", "main"); git(root, "add", "-A"); git(root, "commit", "-qm", "init");
  const run = (...a) => { const x = cp.spawnSync(process.execPath, [FIXIT, ...a], { cwd: root, encoding: "utf8", env: { ...process.env, GOFLAGS: "-count=1" } }); return { code: x.status, out: x.stdout + x.stderr }; };
  const implied = run("test", "svc/price/price_test.go", "--no-cache");
  assert.equal(implied.code, 0, implied.out);
  assert.match(implied.out, /\(ran: go test '\.\/price'\)/);
  fs.writeFileSync(path.join(root, "fixit.config.json"), JSON.stringify({ fileRules: [{ match: "svc/", suffix: "_test.go", cwd: "svc", adapter: "gotest", cmd: "go test -count=1 {file}" }] }));
  const ruled = run("test", "svc/price/price_test.go", "--no-cache");
  assert.equal(ruled.code, 0, ruled.out);
  assert.match(ruled.out, /\(ran: go test -count=1 '\.\/price'\)/);
  fs.appendFileSync(path.join(root, "svc/price/price.go"), "\n");
  const changed = run("test", "--changed", "--no-cache");
  assert.equal(changed.code, 0, changed.out);
  assert.match(changed.out, /'\.\/price'/);
});

test("go sample, against the real go: failure with its assertion and location; green; STOP", { skip: !hasGo && "go is not installed" }, () => {
  const root = tmp("fixit-go-");
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(__dirname, "fixtures", "go-sample"), root, { recursive: true });
  fs.writeFileSync(path.join(root, "fixit.config.json"), JSON.stringify({ lanes: { go: { cmd: "go test ./...", adapter: "gotest", paths: ["price/"] } } }));
  git(root, "init", "-q", "-b", "main"); git(root, "add", "-A"); git(root, "commit", "-qm", "init");
  const run = (...a) => { const x = cp.spawnSync(process.execPath, [FIXIT, ...a], { cwd: root, encoding: "utf8", env: { ...process.env, GOFLAGS: "-count=1" } }); return { code: x.status, out: x.stdout }; };
  const ok = run("test", "go");
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /pass 4 {2}fail 0/);
  assert.match(run("test", "go").out, /already green/);
  const src = path.join(root, "price/price.go");
  fs.writeFileSync(src, fs.readFileSync(src, "utf8").replace("sum += l", "sum += l + 1"));
  const bad = run("test", "go");
  assert.equal(bad.code, 1);
  assert.match(bad.out, /FAIL price\/price_test\.go:8 TestTotal\/sums\n {2}expected 6, got 9/);
  assert.doesNotMatch(bad.out, /FAIL .* TestTotal\n/, "the parent of a failing subtest is not listed twice");
  const id = fs.readdirSync(path.join(root, ".fixit", "runs")).sort()[1];
  assert.match(fs.readFileSync(path.join(root, ".fixit", "runs", id, "raw.log"), "utf8"), /--- FAIL: TestTotal\/sums/, "raw.log is readable text");
  assert.equal(run("test", "go").code, 3, "the same failure twice");
  const narrowed = run("test", "go", "--failed", "--no-cache");
  assert.match(narrowed.out, /pass 0 {2}fail 1|pass 1 {2}fail 1/);
  assert.equal(run("test", "go", "--grep", "TestNothing", "--no-cache").code, 0);
  const none = run("test", "go", "--grep", "NoTestHasThisName", "--no-cache");
  assert.equal(none.code, 2, none.out);
  assert.match(none.out, /pass 0 {2}fail 0/);
  assert.match(none.out, /NOTHING RAN: no test matched --grep "NoTestHasThisName"/);
  fs.writeFileSync(src, "package price\n\nfunc Total(lines []int) int {\n\treturn undefinedThing\n}\n");
  const broken = run("test", "go", "--no-cache");
  assert.equal(broken.code, 1);
  assert.match(broken.out, /FAIL price\/price\.go:4 \(package example\.com\/shop\/price: build failed\)/);
  assert.match(broken.out, /undefined: undefinedThing/);
});

// ───────────── integration with the other phases ─────────────
test("done: a green fixit run for the pinned file clears the warning; a run of something else does not", () => {
  const root = tmp("fixit-done-");
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = tmp("fixit-state-");
  cleanups.push(() => fs.rmSync(state, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "fixit.config.json"), JSON.stringify({ lanes: { unit: { cmd: "vitest run", adapter: "vitest" } } }));
  fs.writeFileSync(path.join(root, "cases.json"), JSON.stringify({ tests: [T("tests/a.test.ts", "widget fits"), T("tests/other.test.ts", "other")] }));
  fs.mkdirSync(path.join(root, "tests")); for (const f of ["a", "other"]) fs.writeFileSync(path.join(root, "tests", f + ".test.ts"), "// sample\n");
  git(root, "init", "-q", "-b", "main"); git(root, "add", "-A"); git(root, "commit", "-qm", "init");
  const env = { ...process.env, PATH: STANDIN + path.delimiter + process.env.PATH, STANDIN_STATE: state };
  const fixit = (...a) => cp.spawnSync(process.execPath, [FIXIT, ...a], { cwd: root, encoding: "utf8", env });
  const remedy = (...a) => { const x = cp.spawnSync(process.execPath, [REMEDY, ...a], { cwd: root, encoding: "utf8", env }); return { code: x.status, out: x.stdout, err: x.stderr }; };
  assert.equal(remedy("init", "--title", "Sample").code, 0);
  const item = (id, pinned) => {
    fs.mkdirSync(path.join(root, "docs"), { recursive: true }); fs.writeFileSync(path.join(root, "docs", id + ".md"), `# ${id}\n`);
    fs.writeFileSync(path.join(root, id + ".json"), JSON.stringify({ id, title: "Widget " + id, pinnedBy: pinned }));
    for (const a of [["add-item", "--json", id + ".json"], ["set-plan", id, "--path", `docs/${id}.md`, "--summary", "s"], ["approve", id, "--by", "Owner"], ["stage", id, "building"]]) assert.equal(remedy(...a).code, 0, a.join(" "));
  };
  item("SEC-01", "tests/a.test.ts › widget fits");
  item("SEC-02", "tests/a.test.ts › widget fits");
  git(root, "add", "-A"); git(root, "commit", "-qm", "items");
  const sha = git(root, "rev-parse", "HEAD");
  // a green run of a different file does not count
  assert.equal(fixit("test", "tests/other.test.ts").status, 0);
  assert.match(remedy("done", "SEC-01", "--commit", sha).out, /warn: no green fixit run found for SEC-01's pinned test tests\/a\.test\.ts; run: fixit test tests\/a\.test\.ts --grep "widget fits"/);
  // a failing run of the pinned file does not count
  fs.writeFileSync(path.join(root, "cases.json"), JSON.stringify({ tests: [T("tests/a.test.ts", "widget fits", "fail", { msg: "no", line: 1 })] }));
  assert.equal(fixit("test", "tests/a.test.ts").status, 1);
  assert.match(remedy("done", "SEC-02", "--commit", sha).out, /warn: no green fixit run/);
  // a run where the pinned test no longer matches anything proves nothing
  item("SEC-06", "tests/a.test.ts › widget fits");
  fs.writeFileSync(path.join(root, "cases.json"), JSON.stringify({ tests: [T("tests/a.test.ts", "renamed test")] }));
  assert.equal(fixit("test", "tests/a.test.ts", "--grep", "widget fits").status, 2);
  assert.match(remedy("done", "SEC-06", "--commit", sha).out, /warn: no green fixit run/);
  // a green run of the pinned file, by file or by lane, does
  fs.writeFileSync(path.join(root, "cases.json"), JSON.stringify({ tests: [T("tests/a.test.ts", "widget fits")] }));
  assert.equal(fixit("test", "unit").status, 0);
  item("SEC-03", "tests/a.test.ts · widget fits (it.fails)");
  assert.doesNotMatch(remedy("done", "SEC-03", "--commit", sha).out, /warn/);
  // a run narrowed by a grep counts only when the grep is the pinned test
  fs.writeFileSync(path.join(root, "tests", "b.test.ts"), "// sample\n");
  fs.writeFileSync(path.join(root, "cases.json"), JSON.stringify({ tests: [T("tests/b.test.ts", "beta holds"), T("tests/b.test.ts", "alpha holds")] }));
  item("SEC-04", "tests/b.test.ts › beta holds");
  git(root, "add", "-A"); git(root, "commit", "-qm", "b");
  const sha2 = git(root, "rev-parse", "HEAD");
  assert.equal(fixit("test", "tests/b.test.ts", "--grep", "alpha").status, 0);
  assert.match(remedy("done", "SEC-04", "--commit", sha2).out, /warn: no green fixit run/);
  item("SEC-05", "tests/b.test.ts › beta holds");
  assert.equal(fixit("test", "tests/b.test.ts", "--grep", "beta holds").status, 0);
  assert.doesNotMatch(remedy("done", "SEC-05", "--commit", sha2).out, /warn/);
});

test("usage counts the shim form and the node form as the fixit kind, and a mention in a path as nothing", () => {
  for (const c of ["fixit test api", "/opt/plugin/bin/fixit test api --bg", "node /opt/plugin/scripts/fixit.cjs test api", 'node "/opt/my plugin/scripts/fixit.cjs" wait x', '"/opt/my plugin/bin/fixit" show last', "cd app && fixit clean", "FIXIT_RAW=1 fixit test x"]) assert.equal(kindOf(c), "fixit", c);
  assert.notEqual(kindOf("cat fixit-plugin/README.md"), "fixit");
  assert.notEqual(kindOf("ls scripts/fixit.cjs"), "fixit");
});

test("bin shims: executable in git, work through a symlink and from a directory with spaces", () => {
  const modes = git(PLUGIN, "ls-files", "-s", "bin").split("\n");
  assert.ok(modes.length >= 2 && modes.every((l) => l.startsWith("100755")), modes.join("\n"));
  const dir = tmp("fixit shim ");
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, "linked fixit"); fs.symlinkSync(path.join(PLUGIN, "bin", "fixit"), link);
  const rlink = path.join(dir, "linked remedy"); fs.symlinkSync(path.join(PLUGIN, "bin", "remedy"), rlink);
  const two = path.join(dir, "two"); fs.symlinkSync(link, two); // a link to a link
  for (const exe of [path.join(PLUGIN, "bin", "fixit"), link, two]) {
    const x = cp.spawnSync(exe, ["help"], { cwd: dir, encoding: "utf8" });
    assert.equal(x.status, 0, exe + x.stderr); assert.match(x.stdout, /^fixit: run tests/);
  }
  const y = cp.spawnSync(rlink, ["help"], { cwd: dir, encoding: "utf8" });
  assert.equal(y.status, 0, y.stderr); assert.match(y.stdout, /remedy/i);
  // copied (not linked) into a path with spaces: the ../ layout is lost, so it must fail cleanly, not hang
  const rel = path.join(dir, "rel link"); fs.symlinkSync(path.relative(dir, path.join(PLUGIN, "bin", "fixit")), rel);
  assert.equal(cp.spawnSync(rel, ["help"], { cwd: dir, encoding: "utf8" }).status, 0, "a relative symlink");
  // from PATH
  const viaPath = cp.spawnSync("fixit", ["help"], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: path.join(PLUGIN, "bin") + path.delimiter + process.env.PATH } });
  assert.equal(viaPath.status, 0);
});

test("no test ran: exit 2, never cached, and the failure count toward STOP survives it", () => {
  const failing = { tests: [T("a.test.ts", "works", "fail", { msg: "no", line: 1 })] };
  const r = repo(UNIT, failing);
  assert.equal(r.run(["test", "unit"]).code, 1);
  const none = r.run(["test", "unit", "--grep", "nothing matches"]);
  assert.equal(none.code, 2, none.out);
  assert.match(none.out, /NOTHING RAN: no test matched --grep "nothing matches"/);
  assert.ok(lines(none.out).length <= 40);
  assert.equal(r.meta(r.runs().at(-1)).result, "empty");
  const before = r.runs().length;
  assert.equal(r.run(["test", "unit", "--grep", "nothing matches"]).code, 2);
  assert.equal(r.runs().length, before + 1, "a run that proved nothing is not cached");
  assert.equal(r.run(["test", "unit"]).code, 3, "the second real failure still stops");
});

test("an emptied suite is not a pass either", () => {
  const r = repo(UNIT, { tests: [] });
  const x = r.run(["test", "unit"]);
  assert.equal(x.code, 2, x.out);
  assert.match(x.out, /NOTHING RAN: no test matched\. This is not a pass/);
});

test("--changed: a lane path written ./ or . covers the whole repo", () => {
  for (const prefix of ["./", "."]) {
    const r = repo({ lanes: { unit: { cmd: "vitest run", adapter: "vitest", paths: [prefix] } } }, { tests: [T("a.test.ts", "works")] }, { "notes.md": "x\n" });
    fs.appendFileSync(path.join(r.root, "notes.md"), "y\n");
    assert.match(r.run(["test", "--changed"]).out, /^fixit test unit /, prefix);
  }
});

test("a project with no vitest is not given to vitest: no red run from npx, whether by file or by --changed", () => {
  const onPath = (d) => { try { fs.accessSync(path.join(d, "vitest"), fs.constants.X_OK); return true; } catch { return false; } };
  const env = { PATH: process.env.PATH.split(path.delimiter).filter((d) => !onPath(d)).join(path.delimiter) };
  const files = { "app.txt": "1\n", "app.test.cjs": "t\n" };
  const r = repo({ lanes: { unit: { cmd: "true" } } }, {}, files);
  fs.appendFileSync(path.join(r.root, "app.txt"), "2\n");
  const x = r.run(["test", "--changed"], { env });
  assert.equal(x.code, 0, x.out);
  assert.match(x.out, /no changed files map to a lane or test file; nothing ran/);
  const y = r.run(["test", "app.test.cjs"], { env });
  assert.equal(y.code, 2);
  assert.match(y.err, /No adapter for app\.test\.cjs\. Add a fileRules entry/);
  assert.equal(r.runs().length, 0, "nothing was started");
  // Declared but not installed, as in a fresh worktree, or installed but not declared: vitest is the project's runner.
  for (const extra of [{ "package.json": JSON.stringify({ devDependencies: { vitest: "1" } }) }, { "node_modules/.bin/vitest": "#!/bin/sh\n" }]) {
    const q = repo({ lanes: { unit: { cmd: "true" } } }, {}, { ...files, ...extra });
    fs.appendFileSync(path.join(q.root, "app.txt"), "2\n");
    q.run(["test", "--changed"], { env });
    assert.ok(q.runs().map((id) => q.meta(id).label).some((l) => l.startsWith("changed:vitest:")), Object.keys(extra)[0]);
  }
});

// ---------- fixit logs ----------
// docker, journalctl and kubectl are stand-ins (fixtures/standin/logtool.cjs), not the real tools; `file:` is real.
const LOGS = require("./lib/log-adapters.cjs");
function logRepo(extraConfig) {
  const root = tmp("fixit-logs-");
  git(root, "init", "-q", "-b", "main");
  if (extraConfig) fs.writeFileSync(path.join(root, "fixit.config.json"), JSON.stringify(extraConfig));
  const args = path.join(root, "args.ndjson");
  const env = { ...process.env, PATH: STANDIN + path.delimiter + process.env.PATH, STANDIN_ARGS: args, STANDIN_LOG: path.join(root, "app.log") };
  delete env.FIXIT_DIR;
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root, env,
    write: (name, text) => fs.writeFileSync(path.join(root, name), Array.isArray(text) ? text.join("\n") + "\n" : text),
    run: (a, o = {}) => { const x = cp.spawnSync(process.execPath, [FIXIT, ...a], { cwd: o.cwd || root, encoding: "utf8", env: { ...env, ...(o.env || {}) }, timeout: 30000 }); return { code: x.status, out: x.stdout, err: x.stderr }; },
    calls: () => (fs.existsSync(args) ? fs.readFileSync(args, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    runs: () => { try { return fs.readdirSync(path.join(root, ".fixit", "logs")).sort(); } catch { return []; } },
  };
}
const logLine = (sec, level, msg, base = Date.UTC(2026, 0, 1, 12, 0, 0)) => `${new Date(base + sec * 1000).toISOString()} ${level} ${msg}`;
const noisy = (n) => Array.from({ length: n }, (_, i) => logLine(i, "INFO", `request id=${1000 + i} served in ${i % 90}ms from 10.0.0.${i % 9}`));

test("logs: a log with one new error template shows only that under --diff <run>", () => {
  const r = logRepo();
  const old = [...noisy(200), ...Array.from({ length: 30 }, (_, i) => logLine(300 + i, "ERROR", `dial tcp 10.1.2.${i % 5}:5432: connect: connection refused`))];
  r.write("app.log", old);
  const first = r.run(["logs", "file:app.log"]);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /ERROR x30 .*dial tcp <ip>:<n>: connect: connection refused/);
  const id = r.runs()[0];
  r.write("app.log", [...old, logLine(400, "ERROR", "panic: nil pointer dereference at handler.go:88"), "\tat main.handle (handler.go:88)", ...noisy(5)]);
  const d = r.run(["logs", "file:app.log", "--diff", id]);
  assert.equal(d.code, 0, d.err);
  const L = lines(d.out);
  assert.ok(L.length <= 30, `${L.length} lines`);
  assert.match(d.out, /new against baseline run .*: 1 of 3 templates/);
  assert.match(d.out, /ERROR x1 .*panic: nil pointer dereference at handler\.go:<n>/);
  assert.doesNotMatch(d.out, /connection refused|served in/, "templates already in the baseline are not shown");
  assert.match(d.out, /L\d+: .*panic: nil pointer dereference at handler\.go:88/, "one raw example with its line number");
  // nothing new: says so
  const same = r.run(["logs", "file:app.log", "--diff", r.runs().at(-1)]);
  assert.match(same.out, /no new templates against the baseline/);
});

test("logs: output is at most 30 lines however many templates there are, errors first", () => {
  const r = logRepo();
  const many = [];
  for (let i = 0; i < 120; i++) many.push(logLine(i, i % 3 === 0 ? "ERROR" : "INFO", `step${"abcdefghijklmnopqrstuvwxyz"[i % 26]}${"abcdefghijklmnopqrstuvwxyz"[Math.floor(i / 26)]} did thing${"abcdefghij"[i % 10]}`));
  r.write("app.log", many);
  const x = r.run(["logs", "file:app.log"]);
  assert.equal(x.code, 0, x.err);
  const L = lines(x.out);
  assert.ok(L.length <= 30, `${L.length} lines`);
  assert.ok(L.every((l) => l.length <= 200));
  assert.match(x.out, /\d+ more templates/);
  assert.match(L[1], /^ERROR /, "errors come first");
  const byLevel = r.run(["logs", "file:app.log", "--level", "error"]);
  assert.doesNotMatch(byLevel.out, /^INFO /m);
  assert.ok(lines(byLevel.out).length <= 30);
  const g = r.run(["logs", "file:app.log", "--grep", "stepa"]);
  assert.match(g.out, /stepa/);
});

test("logs: --around prints 20 lines either side of a line, from the saved log, bounded", () => {
  const r = logRepo();
  r.write("app.log", noisy(500));
  r.run(["logs", "file:app.log"]);
  const mid = r.run(["logs", "--around", "250"]);
  assert.equal(mid.code, 0, mid.err);
  const L = lines(mid.out);
  assert.equal(L.length, 1 + 41);
  assert.match(L[0], /lines 230-270 of 500 \(around 250\)/);
  assert.match(L[21], /^> *250: /);
  const top = lines(r.run(["logs", "--around", "3"]).out);
  assert.match(top[0], /lines 1-23 of 500/);
  const end = lines(r.run(["logs", "--around", "500"]).out);
  assert.match(end[0], /lines 480-500 of 500/);
  assert.equal(r.run(["logs", "--around", "501"]).code, 2);
  assert.equal(r.run(["logs", "--around", "abc"]).code, 2);
  // a very long line is cut
  r.write("app.log", ["x".repeat(5000), "y"]);
  r.run(["logs", "file:app.log"]);
  assert.ok(lines(r.run(["logs", "--around", "1"]).out).every((l) => l.length <= 200));
  // --run picks an older run
  const older = r.runs()[0];
  assert.match(r.run(["logs", "--around", "250", "--run", older]).out, new RegExp(`run ${older}: lines 230-270 of 500`));
});

test("logs: .fixit/logs is created under a self-ignoring .fixit even when nothing else made it, and files are private", () => {
  const r = logRepo();
  assert.equal(fs.existsSync(path.join(r.root, ".fixit")), false);
  r.write("app.log", ["token=hunter2 login failed"]);
  const x = r.run(["logs", "file:app.log"]);
  assert.equal(x.code, 0, x.err);
  assert.equal(fs.readFileSync(path.join(r.root, ".fixit", ".gitignore"), "utf8"), "*\n");
  assert.equal(git(r.root, "status", "--short", "--ignored").split("\n").filter((l) => !/app\.log/.test(l)).join("|"), "!! .fixit/");
  assert.doesNotMatch(git(r.root, "status", "--short"), /\.fixit/, "nothing from .fixit/ is offered to git");
  const id = r.runs()[0], raw = path.join(r.root, ".fixit", "logs", id, "raw.log");
  assert.equal(fs.statSync(raw).mode & 0o077, 0, "raw.log is not readable by others");
  assert.equal(fs.statSync(path.join(r.root, ".fixit", "logs")).mode & 0o077, 0);
  // an existing .gitignore is left alone
  fs.writeFileSync(path.join(r.root, ".fixit", ".gitignore"), "*\n!keep\n");
  r.run(["logs", "file:app.log"]);
  assert.equal(fs.readFileSync(path.join(r.root, ".fixit", ".gitignore"), "utf8"), "*\n!keep\n");
});

test("logs: --diff <time> takes a baseline window of the same length that ends exactly at that time", () => {
  const r = logRepo();
  const base = Date.UTC(2026, 0, 1, 12, 0, 0), at = (sec, lvl, msg) => logLine(sec, lvl, msg, base);
  // main window is 12:00:00-12:10:00 (10 minutes), so the baseline is 11:50:00-12:00:00, half-open [start, end)
  r.write("app.log", [
    at(-601, "ERROR", "alpha broke"), // 11:49:59: one second before the baseline starts, so not in it
    at(-600, "ERROR", "beta broke"), //  11:50:00: the first second of the baseline
    at(-1, "ERROR", "gamma broke"), //   11:59:59: the last second of the baseline
    at(0, "ERROR", "delta broke"), //    12:00:00: the main window only
    at(300, "ERROR", "beta broke"),
    at(310, "ERROR", "alpha broke"),
    at(320, "ERROR", "epsilon broke"),
    at(600, "ERROR", "zeta broke"), //   12:10:00: the end is exclusive
  ]);
  const x = r.run(["logs", "docker:api", "--since", "2026-01-01T12:00:00Z", "--until", "2026-01-01T12:10:00Z", "--diff", "2026-01-01T12:00:00Z"], { env: { STANDIN_LOG: path.join(r.root, "app.log") } });
  assert.equal(x.code, 0, x.err + x.out);
  assert.match(x.out, /baseline 2026-01-01T11:50:00Z to 2026-01-01T12:00:00Z/);
  const shown = [...x.out.matchAll(/^(?:ERROR|WARN|INFO) x\d+ .* (\w+) broke$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(shown, ["alpha", "delta", "epsilon"], "alpha is new (11:49:59 is outside the baseline), beta and gamma are in it, zeta is past the end");
  // what the tool was asked for
  const [main, base2] = r.calls();
  assert.deepEqual(main.slice(0, 6), ["docker", "logs", "--timestamps", "--since", "2026-01-01T12:00:00.000Z", "--until"]);
  assert.equal(main[6], "2026-01-01T12:10:00.000Z");
  assert.equal(base2[4], "2026-01-01T11:50:00.000Z");
  assert.equal(base2[6], "2026-01-01T12:00:00.000Z");
  // a baseline time needs a window to copy the length of
  assert.equal(r.run(["logs", "file:app.log", "--diff", "2026-01-01T12:00:00Z"]).code, 2);
  assert.equal(r.run(["logs", "docker:api", "--since", "10m", "--diff", "2999-01-01T00:00:00Z"]).code, 2, "a baseline time after the window's end is refused");
});

test("logs: each adapter builds its command as an argument list, and a bad name never reaches a tool", () => {
  const r = logRepo({ logs: { api: "docker:api", worker: { source: "kubectl:prod/worker-1" } } });
  r.write("app.log", ["x"]);
  const win = ["--since", "2026-01-01T12:00:00Z", "--until", "2026-01-01T12:10:00Z"];
  for (const [src, want] of [
    ["docker:api", ["docker", "logs", "--timestamps", "--since", "2026-01-01T12:00:00.000Z", "--until", "2026-01-01T12:10:00.000Z", "api"]],
    ["compose:web@ci.yml", ["docker", "compose", "-f", "ci.yml", "logs", "--no-color", "--timestamps", "--since", "2026-01-01T12:00:00.000Z", "--until", "2026-01-01T12:10:00.000Z", "web"]],
    ["journald:nginx.service", ["journalctl", "--no-pager", "--utc", "-o", "short-iso", "-u", "nginx.service", "--since", "2026-01-01 12:00:00", "--until", "2026-01-01 12:10:00"]],
    ["kubectl:prod/pod-7", ["kubectl", "logs", "--timestamps", "-n", "prod", "--since-time=2026-01-01T12:00:00.000Z", "pod-7"]],
    ["worker", ["kubectl", "logs", "--timestamps", "-n", "prod", "--since-time=2026-01-01T12:00:00.000Z", "worker-1"]],
    ["api", ["docker", "logs", "--timestamps", "--since", "2026-01-01T12:00:00.000Z", "--until", "2026-01-01T12:10:00.000Z", "api"]],
  ]) {
    const before = r.calls().length;
    const x = r.run(["logs", src, ...win]);
    assert.equal(x.code, 0, `${src}: ${x.err}${x.out}`);
    assert.deepEqual(r.calls().slice(before)[0], want, src);
  }
  const before = r.calls().length;
  for (const bad of ["docker:x;touch pwned", "docker:$(id)", "docker:-f", "journald:a b", "kubectl:../x", "nosuch:thing", "docker:"]) {
    const x = r.run(["logs", bad, "--since", "5m"]);
    assert.equal(x.code, 2, bad);
  }
  assert.equal(r.calls().length, before, "no tool was started for a bad name");
  assert.equal(fs.existsSync(path.join(r.root, "pwned")), false);
});

test("logs: a missing tool or a failing tool is exit 2 with a plain message", () => {
  const r = logRepo();
  const none = r.run(["logs", "journald:x", "--since", "5m"], { env: { PATH: r.root } });
  assert.equal(none.code, 2);
  assert.match(none.err, /journalctl is not installed or not on PATH/);
  r.write("app.log", ["Error response from daemon: No such container: gone"]);
  const fail = r.run(["logs", "docker:gone", "--since", "5m"], { env: { STANDIN_EXIT: "1" } });
  assert.equal(fail.code, 2);
  assert.match(fail.err, /docker logs failed \(exit 1\): .*No such container: gone/);
  assert.equal(r.run(["logs", "file:missing.log"]).code, 2);
  assert.equal(r.run(["logs"]).code, 2);
});

test("logs: short output is shown whole; big output is a digest of at most 30 lines", () => {
  const r = logRepo();
  fs.writeFileSync(path.join(r.root, "short.log"), "one\ntwo\n");
  const x = r.run(["logs", "file:short.log"]);
  assert.equal(x.code, 0, x.err);
  assert.match(x.out, /^one$/m);
  assert.match(x.out, /^run \d{8}-/m);
  const text = Array.from({ length: 400 }, (_, i) => `2026-01-01T12:00:${String(i % 60).padStart(2, "0")}Z ERROR job ${i} failed: code ${i % 7} host-${i % 5}`).join("\n") + "\n";
  fs.writeFileSync(path.join(r.root, "big.log"), text);
  const big = r.run(["logs", "file:big.log"]);
  assert.equal(big.code, 0, big.err);
  assert.ok(lines(big.out).length <= 30);
  assert.match(big.out, /ERROR x\d+/);
});

test("logs: the normaliser removes timestamps, UUIDs, hex ids, IPs and numbers; levels; one trace is one template", () => {
  const n = (s) => LOGS.normalise(s);
  assert.equal(n("2026-11-03T10:00:01.123Z request 8f14e45f-ceea-4672-9a15-0123456789ab from 192.168.1.20:5432 took 345ms id=deadbeef12"), "<ts> request <uuid> from <ip>:<n> took <n>ms id=<hex>");
  assert.equal(n("Nov  3 10:00:01 host app[4242]: opened 0x7ffe5 file"), "<ts> host app[<n>]: opened <hex> file");
  assert.equal(n('10.0.0.1 - - [03/Nov/2026:10:00:01 +0000] "GET /a/17 HTTP/1.1" 200 512'), '<ip> - - [<ts>] "GET /a/<n> HTTP/<n>" <n> <n>');
  assert.equal(n("failure accepted decoded"), "failure accepted decoded", "ordinary words are not hex ids");
  assert.equal(LOGS.levelOf('{"level":"error","msg":"x"}', { level: "error" }), "error");
  assert.equal(LOGS.levelOf("level=warn msg=x"), "warn");
  assert.equal(LOGS.levelOf("12:00 [ERROR] boom"), "error");
  assert.equal(LOGS.levelOf("12:00 all fine"), "info");
  const trace = ["2026-01-01T12:00:00Z ERROR Unhandled: boom", "\tat a.b (x.js:1)", "\tat c.d (x.js:2)", "Caused by: other", "2026-01-01T12:00:01Z INFO next"].join("\n");
  const es = LOGS.readEntries(trace);
  assert.equal(es.length, 2);
  assert.equal(es[0].more, 3);
  // JSON lines group on their message
  const js = LOGS.readEntries('{"time":"2026-01-01T12:00:00Z","level":"error","msg":"db timeout after 30s"}\n{"time":"2026-01-01T12:00:05Z","level":"error","msg":"db timeout after 31s"}\n');
  assert.equal(js[0].key, js[1].key);
  assert.equal(js[0].level, "error");
});

test("logs: a small log is shown whole, and --run reprocesses a saved run without making a new one", () => {
  const r = logRepo();
  r.write("app.log", ["plain line one", "plain line two"]);
  const x = r.run(["logs", "file:app.log"]);
  assert.deepEqual(lines(x.out).slice(1, 3), ["plain line one", "plain line two"]);
  const id = r.runs()[0];
  const again = r.run(["logs", "--run", id, "--level", "error"]);
  assert.equal(again.code, 0, again.err);
  assert.equal(r.runs().length, 1);
  assert.equal(r.run(["logs", "--run", "20200101-000000-000"]).code, 2);
  assert.equal(r.run(["logs", "--run", "../../etc"]).code, 2);
});

test("logs: clean removes old log runs too", () => {
  const r = logRepo();
  r.write("app.log", ["x"]);
  r.run(["logs", "file:app.log"]);
  const id = r.runs()[0], mp = path.join(r.root, ".fixit", "logs", id, "meta.json");
  const m = JSON.parse(fs.readFileSync(mp, "utf8")); m.createdAt = "2020-01-01T00:00:00Z"; fs.writeFileSync(mp, JSON.stringify(m));
  const c = r.run(["clean", "--days", "14"]);
  assert.match(c.out, /1 log run/);
  assert.deepEqual(r.runs(), []);
});
