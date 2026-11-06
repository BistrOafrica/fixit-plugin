#!/usr/bin/env node
/* fixit output guard (PostToolUse, Bash) — zero dependencies, Node >= 18.
 *
 * Output over the cap is saved in full to <git root>/.fixit/out/ and the model
 * gets its head, its tail and the path, so nothing needs re-running to see more.
 *
 * Seen on Claude Code 2.1.314:
 *   - A command that exits non-zero fires PostToolUseFailure, not this hook.
 *   - stdout here is already cut at BASH_MAX_OUTPUT_LENGTH. When it was cut,
 *     persistedOutputPath names a file with the full text, stderr merged in.
 *
 * Any error exits 0 with no output, which leaves the tool's own result in
 * place: a guard bug must never block a tool call. FIXIT_GUARD=off turns it off.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const CAP = 6000;
const KEEP = 1000;
const MAX_LOGS = 500;

function gitRoot(cwd) {
  try { return cp.execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).toString().trim(); }
  catch { return cwd; }
}
const countNewlines = (s) => { let n = 0; for (let i = s.indexOf("\n"); i >= 0; i = s.indexOf("\n", i + 1)) n++; return n; };
// Cut back to a line boundary, unless a single line fills the whole span.
function headOf(text, keep) {
  const nl = text.lastIndexOf("\n", keep - 1);
  return text.slice(0, nl > 0 ? nl + 1 : keep);
}
function tailOf(text, keep) {
  const from = text.length - keep;
  const nl = text.indexOf("\n", from);
  return text.slice(nl >= 0 && nl + 1 < text.length ? nl + 1 : from);
}
function prune(dir) {
  const logs = fs.readdirSync(dir).filter((f) => f.endsWith(".log")).sort();
  for (const f of logs.slice(0, Math.max(0, logs.length - MAX_LOGS))) fs.rmSync(path.join(dir, f), { force: true });
}

function guard(input) {
  const res = input.tool_response;
  if (input.tool_input?.run_in_background || typeof res?.stdout !== "string" || res.isImage) return null;
  const stderr = typeof res.stderr === "string" ? res.stderr : "";
  if (Math.max(res.stdout.length + stderr.length, res.persistedOutputSize || 0) <= CAP) return null;

  const stdout = res.persistedOutputPath ? fs.readFileSync(res.persistedOutputPath, "utf8") : res.stdout;
  const body = stderr ? `${stdout}\n--- stderr ---\n${stderr}` : stdout;
  const preamble = `$ ${input.tool_input?.command ?? ""}\n--- output ---\n`;

  const root = gitRoot(input.cwd || process.cwd());
  const fixit = path.join(root, ".fixit");
  const dir = path.join(fixit, "out");
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(fixit, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n"); // logs can hold secrets
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const id = `${stamp}-${crypto.randomBytes(3).toString("hex")}`;
  const log = path.join(dir, `${id}.log`);
  fs.writeFileSync(log, preamble + body, { mode: 0o600 });
  try { prune(dir); } catch { /* a full directory costs less than a lost digest */ }

  const footer = `[fixit] ${countNewlines(body) + 1} lines, ${body.length} chars. Full output: .fixit/out/${id}.log. Read a range: sed -n 'A,Bp' ${log}`;
  // Sized for the gap line's longest form, so a long path cannot push the digest past the cap.
  const keep = Math.max(0, Math.min(KEEP, Math.floor((CAP - footer.length - 60) / 2)));
  const head = headOf(body, keep), tail = tailOf(body, keep);
  const firstCut = countNewlines(preamble + head) + 1;
  const lastCut = countNewlines(preamble + body.slice(0, body.length - tail.length));
  const end = (s) => (!s || s.endsWith("\n") ? s : s + "\n");
  const digest = `${end(head)}[fixit] log lines ${firstCut}-${lastCut} cut here\n${end(tail)}${footer}`;
  return { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: { stdout: digest, stderr: "", interrupted: !!res.interrupted, isImage: false } } };
}

try {
  if (process.env.FIXIT_GUARD !== "off") {
    const out = guard(JSON.parse(fs.readFileSync(0, "utf8")));
    if (out) process.stdout.write(JSON.stringify(out));
  }
} catch { /* see header: never block a tool call */ }
