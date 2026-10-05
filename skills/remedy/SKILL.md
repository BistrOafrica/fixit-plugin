---
name: remedy
description: Gated remediation programme for a codebase — a bug register plus a tracker where every defect, TODO and gap gets its own planning run, an owner approval gate, and a build session that flips a pinned test. Use when asked to set up a remediation/bug tracker or register, triage audit findings or test-campaign bugs into a fix plan, "plan <ID>" / "plan cluster <X>", "build <ID>", check what is waiting for approval, or sync a register. Works with the bundled security-audit and test-campaign skills as its intake.
---

# Remedy — gated remediation

Turn a pile of findings into fixes that are **planned deliberately, approved by a human, and proven by a test**. The system has two records and one rule:

- **Register**: confirmed defects, keyed (`SEC-01`), with severity, location, how they were found and a fix status (`open → in_progress → fix_in_review → fixed`, or `wont_fix`).
- **Tracker**: every unit of work (each register defect plus TODOs, stubs, gaps, debt, needs-validation leads), with a stage, a wave, an optional cluster, a plan file and a history.
- **The rule (the gate)**: nothing is built until its plan is written to the repo and an **owner** has approved it. Changing an approved plan withdraws the approval.

Read [PROTOCOL.md](PROTOCOL.md) first: data model, stages, severities, waves, clusters, IDs.

## When to load which file

| Task | Read |
|---|---|
| Set up a programme in a repo, pick the backend | [BACKENDS.md](BACKENDS.md), then `remedy init` |
| Fill it: audit findings, failing/pinned tests, TODO sweep, side finds | [INTAKE.md](INTAKE.md) |
| "plan SEC-01", "plan cluster AUTH", "plan the next cluster" | [PLANNING.md](PLANNING.md) + `templates/` |
| "build SEC-01", "implement the approved plans" | [BUILD.md](BUILD.md) |
| Another Claude session is working the same tracker | [COORDINATION.md](COORDINATION.md) |
| A security audit is requested first | the bundled `security-audit` skill, then INTAKE.md §1 |
| Testing to find defects (load/k6, Playwright, simulation, capacity) | the bundled `test-campaign` skill, then INTAKE.md §1b |

## The CLI

`scripts/remedy.cjs` (zero dependencies, Node ≥ 18) owns the local ledger at `<repo>/.remedy/` and enforces the gate. Resolve its absolute path from this skill's directory and run it with `node`. Key commands: `init`, `status`, `next-id`, `add-item`, `add-row`, `cluster`, `set-plan`, `stage`, `approve`, `request-changes`, `sync-register`, `import-findings`, `import-campaign`, `scan`, `validate`, `render`, `export-artifact`, `import-artifact`. `node remedy.cjs help` lists flags. Run `validate` after every batch of changes.

## Non-negotiables

1. **Never approve on the owner's behalf.** `approve` (CLI) and the Approve button (artifact) are the owner's. Run `approve` only when the owner explicitly tells you to approve a named item in this conversation ("mark SEC-26 approved"), and record their name with `--by`.
2. **Never build past the gate.** Before writing product code for an item, confirm `plan.approvedAt` is set. If the owner asks to build an unapproved item, say so and offer to (a) finish the plan and ask for approval, or (b) record their explicit approval first.
3. **One plan per item**, even when one planning run covers a cluster. Each item gets `<planDir>/<ID>.md`; the cluster gets `<planDir>/<CLUSTER>.md`.
4. **Decisions belong to the owner.** During planning, ask only questions whose answer changes what gets built, with your recommended option first. Record each decision in the plan ("Decision (owner, <date>)") and in the cluster overview.
5. **Evidence over assertion.** Every root cause cites `file:line`; reproduce when you can (a failing test, a headless render, a curl against a local stack). Say what you ruled out.
6. **Pinned tests.** Each bug's plan names the test that fails before the fix and passes after (`pinnedBy`). The build flips it in the same change.
7. **New finds go on the record.** A defect discovered while planning or building becomes a register row + a tracker item (in its cluster, or standalone backlog) — never a silent fix and never only a chat remark.
8. **No product code in a planning run.** Planning writes docs and ledger state only.
9. **Don't clobber.** Items are create-only (`add-item` refuses an existing id); before writing a plan doc, check the file does not already exist; pin artifact writes with `if_version`.

## Communicating

Report each run as: what is now in Plan review (by item, one line each), new items found, decisions the owner still has to make at approval, and the suggested next cluster. Link plan files as repo-relative paths. Keep the owner's vocabulary.
