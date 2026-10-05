# Planning runs

A planning run turns backlog items into approved-ready plans. Trigger: "plan SEC-01", "plan cluster AUTH", "proceed to the next cluster". It writes **documents and ledger state only — never product code.**

## Steps

1. **Load.** `remedy status`, then read the target items (`remedy show ID`) and the cluster's members. Read related plan docs already in `<planDir>/` (earlier clusters often constrain this one). If the owner named a cluster that doesn't exist, pick the next by wave order and say so. Move items to `planning` (`remedy stage ID planning`).
2. **Investigate.** Verify every claim in the item against current code; the original report may be stale. For each item establish: root cause with `file:line`, blast radius (every caller/consumer), what already exists that the fix can reuse, and what other plans touch the same files.
   - Reproduce when cheap and safe: run the pinned test, render the page headlessly, call the endpoint on a local stack. A reproduction beats a theory — the blank-map plan was only right because the page was rendered and measured.
   - Use read-only exploration subagents for wide surveys; keep their conclusions, not file dumps.
   - Check the other active plans for overlap (same files, same tables, contradictory decisions) and record the interaction.
3. **Ask the owner — only what is theirs to decide.** Product policy, who may do what, trade-offs with user impact, scope. Not things the code answers. Use multiple-choice questions, your recommended option first and labelled, each option with its consequence; 1–4 questions per round. If an answer introduces a principle ("a reviewer never changes submission data"), apply it across the cluster and look for existing code that violates it — that is often a new item.
4. **Write the plans** from [templates/](templates/):
   - `<planDir>/<CLUSTER>.md` — what's wrong today, owner decisions with date, design summary, build order, interactions with other plans, verification.
   - `<planDir>/<ID>.md` per item — root cause, decision, fix, files, tests (the test that **fails before** the fix and passes after, named as `pinnedBy`), acceptance.
   - Before writing, check the file doesn't already exist (a parallel session may own it).
5. **Record.** For each item: `remedy set-plan ID --path <planDir>/<ID>.md --summary "<one paragraph: cause → fix → test>"` (moves it to plan_review; withdraws a prior approval if the plan changed). Update `pinnedBy`, `dependsOn`, `cluster` as the plan decided. New items found → INTAKE.md §5. Run `remedy validate`.
6. **Mirror** to the live artifacts if that backend is in use (BACKENDS.md), and persist the owner's decisions where future sessions will see them (the cluster doc always; project memory if available).
7. **Report** (SKILL.md, Communicating), then stop. The next step is the owner's approval.

## Plan quality bar

- A stranger can build it without re-investigating: exact files, functions, data shapes, migrations, flags, and order.
- The smallest change that enforces the invariant at the last trusted decision point; name the invariant.
- Every decision traceable to the owner or to code evidence.
- Tests: the failing-before test, regression tests for the edges, and how the gate (CI) keeps it fixed.
- Interactions: which other items must land first, which plans must change when this lands.
- Out-of-scope observations go in a short "noted, not in scope" paragraph — never silently added.

## Revising a plan

If the owner changes a decision after approval, rewrite the plan doc, run `set-plan` again (approval withdrawn), and tell the owner it needs re-approval. Keep the history.
