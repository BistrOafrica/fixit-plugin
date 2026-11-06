// node --test hooks/hooks.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const HOOK = path.join(__dirname, "post-bash.cjs");
const CAP = 6000;
function sandbox({ git = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fixit-hook-")));
  if (git) cp.execFileSync("git", ["init", "-q", root]);
  return root;
}
function runRaw(stdin, env = {}) {
  const r = cp.spawnSync(process.execPath, [HOOK], { input: stdin, encoding: "utf8", env: { ...process.env, FIXIT_GUARD: "", ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function fixture(cwd, response, input = { command: "make noisy" }) {
  return { hook_event_name: "PostToolUse", tool_name: "Bash", cwd, tool_input: input, tool_response: { stderr: "", interrupted: false, isImage: false, ...response } };
}
const run = (fx, env) => runRaw(JSON.stringify(fx), env);
const digestOf = (r) => JSON.parse(r.out).hookSpecificOutput.updatedToolOutput.stdout;
const logs = (root) => fs.readdirSync(path.join(root, ".fixit", "out"));
const lines = (n, width = 49) => Array.from({ length: n }, (_, i) => `line ${String(i).padStart(5, "0")} ${"x".repeat(width - 11)}`).join("\n") + "\n";

test("under the cap is untouched and writes nothing", () => {
  const root = sandbox();
  const r = run(fixture(root, { stdout: "x".repeat(CAP - 10), stderr: "y".repeat(10) }));
  assert.deepEqual([r.code, r.out], [0, ""]);
  assert.equal(fs.existsSync(path.join(root, ".fixit")), false);
});

test("50k of output returns under the cap, in the documented shape, with the full log on disk", () => {
  const root = sandbox();
  const stdout = lines(1000), stderr = "warning: on stderr\n";
  const r = run(fixture(root, { stdout, stderr, interrupted: true }));
  assert.equal(r.code, 0);
  const o = JSON.parse(r.out).hookSpecificOutput;
  assert.equal(o.hookEventName, "PostToolUse");
  assert.deepEqual(Object.keys(o.updatedToolOutput), ["stdout", "stderr", "interrupted", "isImage"]);
  assert.deepEqual([o.updatedToolOutput.stderr, o.updatedToolOutput.interrupted, o.updatedToolOutput.isImage], ["", true, false]);
  const digest = o.updatedToolOutput.stdout;
  assert.ok(digest.length <= CAP, `digest is ${digest.length} chars`);
  const [name] = logs(root);
  assert.match(name, /^\d{8}-\d{6}-[0-9a-f]{6}\.log$/);
  const logPath = path.join(root, ".fixit", "out", name);
  const log = fs.readFileSync(logPath, "utf8");
  assert.ok(log.startsWith("$ make noisy\n"));
  assert.ok(log.includes(stdout) && log.includes(stderr));
  assert.equal(fs.readFileSync(path.join(root, ".fixit", ".gitignore"), "utf8"), "*\n");
  assert.match(digest, new RegExp(`\\[fixit\\] \\d+ lines, \\d+ chars\\. Full output: \\.fixit/out/${name.replace(/\./g, "\\.")}\\. Read a range: sed -n 'A,Bp' ${logPath.replace(/[.\\]/g, "\\$&")}$`));
  assert.ok(digest.startsWith("line 00000") && digest.includes("warning: on stderr"));
});

test("the digest cuts at line boundaries and names the cut lines of the log", () => {
  const root = sandbox();
  const r = run(fixture(root, { stdout: lines(1000) }));
  const digest = digestOf(r);
  const m = digest.match(/\[fixit\] log lines (\d+)-(\d+) cut here/);
  assert.ok(m);
  const before = digest.slice(0, m.index), after = digest.slice(m.index + m[0].length + 1);
  assert.ok(before.endsWith("\n"));
  assert.match(after, /^line \d{5} x+\n/);
  const log = fs.readFileSync(path.join(root, ".fixit", "out", logs(root)[0]), "utf8").split("\n");
  // The named range is exactly what the digest left out: the lines either side were shown.
  assert.ok(before.trimEnd().endsWith(log[+m[1] - 2]));
  assert.ok(after.startsWith(log[+m[2]]));
  assert.ok(!digest.includes(log[+m[1] - 1]) && !digest.includes(log[+m[2] - 1]));
});

test("output cut at BASH_MAX_OUTPUT_LENGTH: the full log comes from persistedOutputPath", () => {
  const root = sandbox();
  const full = lines(1000);
  const persisted = path.join(root, "persisted.txt");
  fs.writeFileSync(persisted, full);
  const r = run(fixture(root, { stdout: full.slice(0, 8000), persistedOutputPath: persisted, persistedOutputSize: full.length }));
  const digest = digestOf(r);
  assert.ok(digest.length <= CAP);
  assert.ok(digest.includes(`1001 lines, ${full.length} chars`));
  assert.ok(digest.includes("line 00999"), "the tail comes from the full text, not the cut stdout");
  assert.ok(fs.readFileSync(path.join(root, ".fixit", "out", logs(root)[0]), "utf8").endsWith(full));
});

test("a persisted file that cannot be read leaves the tool's own result in place", () => {
  const root = sandbox();
  const r = run(fixture(root, { stdout: "x".repeat(8000), persistedOutputPath: path.join(root, "gone.txt"), persistedOutputSize: 50000 }));
  assert.deepEqual([r.code, r.out], [0, ""]);
});

test("skipped: background commands, images, and responses without string stdout", () => {
  const root = sandbox();
  const big = "x".repeat(CAP * 2);
  for (const fx of [
    fixture(root, { stdout: big }, { command: "x", run_in_background: true }),
    fixture(root, { stdout: big, isImage: true }),
    fixture(root, { stdout: 42 }),
    { cwd: root, tool_input: { command: "x" }, tool_response: "a string" },
    { cwd: root, tool_input: { command: "x" } },
  ]) assert.deepEqual([run(fx).code, run(fx).out], [0, ""]);
  assert.equal(fs.existsSync(path.join(root, ".fixit")), false);
});

test("a hook failure exits 0 with no output, so the tool call is never blocked", () => {
  for (const bad of ["", "not json", "[]", "null"]) assert.deepEqual((({ code, out }) => [code, out])(runRaw(bad)), [0, ""]);
  const root = sandbox();
  fs.writeFileSync(path.join(root, ".fixit"), "a file where the directory should be");
  const r = run(fixture(root, { stdout: "x".repeat(CAP * 2) }));
  assert.deepEqual([r.code, r.out, r.err], [0, "", ""]);
});

test("FIXIT_GUARD=off exits at once", () => {
  const root = sandbox();
  const r = run(fixture(root, { stdout: "x".repeat(CAP * 2) }), { FIXIT_GUARD: "off" });
  assert.deepEqual([r.code, r.out], [0, ""]);
  assert.equal(fs.existsSync(path.join(root, ".fixit")), false);
  assert.equal(runRaw("not json", { FIXIT_GUARD: "off" }).code, 0);
});

test("logs go to the git root from a subdirectory, and to cwd outside a repo", () => {
  const root = sandbox();
  const sub = path.join(root, "a", "b");
  fs.mkdirSync(sub, { recursive: true });
  run(fixture(sub, { stdout: "x".repeat(CAP * 2) }));
  assert.equal(logs(root).length, 1);
  assert.equal(fs.existsSync(path.join(sub, ".fixit")), false);
  const plain = sandbox({ git: false });
  run(fixture(plain, { stdout: "x".repeat(CAP * 2) }));
  assert.equal(logs(plain).length, 1);
});

test("one huge line with no newline is cut hard and stays under the cap", () => {
  const root = sandbox();
  const digest = digestOf(run(fixture(root, { stdout: "x".repeat(50000) })));
  assert.ok(digest.length <= CAP);
  assert.equal(digest.split("\n")[0].length, 1000);
});

test("a very long path still fits the cap", () => {
  let deep = sandbox();
  for (let i = 0; i < 12; i++) deep = path.join(deep, "d".repeat(200));
  fs.mkdirSync(deep, { recursive: true });
  cp.execFileSync("git", ["init", "-q", deep]);
  const digest = digestOf(run(fixture(deep, { stdout: lines(1000) })));
  assert.ok(digest.length <= CAP, `digest is ${digest.length} chars`);
});

test("past 500 logs the oldest are deleted", () => {
  const root = sandbox();
  const dir = path.join(root, ".fixit", "out");
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 505; i++) fs.writeFileSync(path.join(dir, `20200101-000000-${String(i).padStart(6, "0")}.log`), "old");
  run(fixture(root, { stdout: "x".repeat(CAP * 2) }));
  const left = logs(root);
  assert.equal(left.length, 500);
  assert.ok(!left.includes("20200101-000000-000000.log") && !left.includes("20200101-000000-000005.log"));
  assert.ok(left.includes("20200101-000000-000006.log"));
  assert.ok(left.some((f) => !f.startsWith("2020")), "the new log survives");
});

test("hooks.json registers the guard on Bash with a script that exists", () => {
  const { hooks } = JSON.parse(fs.readFileSync(path.join(__dirname, "hooks.json"), "utf8"));
  const [entry] = hooks.PostToolUse;
  assert.equal(entry.matcher, "Bash");
  const m = entry.hooks[0].command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/(hooks\/[\w.-]+)/);
  assert.ok(fs.existsSync(path.join(__dirname, "..", m[1])));
});
