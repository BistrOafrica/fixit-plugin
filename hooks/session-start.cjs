#!/usr/bin/env node
/* fixit session start (SessionStart, resume) — zero dependencies, Node >= 18.
 *
 * A session resumed at large context pays to re-read all of it, so past RESUME_ADVISE it prints one line advising a
 * fresh session from a handoff. No ledger in this project: nothing. Any error exits 0 with no output.
 * FIXIT_GUARD=off turns it off.
 */
"use strict";
const fs = require("fs");
const { ledgerRoot, contextOf } = require("./context-guard.cjs");

const RESUME_ADVISE = 100000;

function advice(input, env = process.env) {
  if (input.source && input.source !== "resume") return null;
  if (!ledgerRoot(input.cwd, env)) return null;
  // The documented field where present; otherwise the newest usage in the transcript.
  const ctx = Number(input.context_tokens) > 0 ? Number(input.context_tokens) : input.transcript_path ? contextOf(input.transcript_path) : null;
  if (ctx == null || ctx <= RESUME_ADVISE) return null;
  return `[fixit] Resumed at ${Math.round(ctx / 1000)}k of context. A fresh session is cheaper: remedy handoff, then claude, then remedy handoff --latest.`;
}

if (require.main === module) {
  try {
    if (process.env.FIXIT_GUARD !== "off") {
      const line = advice(JSON.parse(fs.readFileSync(0, "utf8")));
      if (line) process.stdout.write(line + "\n");
    }
  } catch { /* never block a session */ }
}
module.exports = { advice, RESUME_ADVISE };
