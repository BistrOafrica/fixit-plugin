# Planning runs

A planning run turns backlog items into approval-ready plans. It writes **documents and ledger state only, never product code**. It runs in a `remedy-planner` worker on Opus, one cluster per worker, and **a planner is never resumed**. A resumed planner keeps its whole context; planners resumed across rounds reached 955k.

## Steps
1. **Lead.** `remedy stage A,B,C planning`. Spawn a planner with the cluster id and this file's path. If a cluster does not exist, pick the next by wave order and say so.
2. **Load.** `remedy status --cluster ID`, and `remedy brief ID --role planner` per item. Read related plan docs in `<planDir>/`, because earlier clusters often constrain this one.
3. **Investigate.** Verify every claim against current code. For each item establish root cause with `file:line`, blast radius, reusable code, and other plans touching the same files. Reproduce when cheap and safe, using `fixit test` and `fixit logs`, never raw `vitest`, `go test`, `make test-*` or `docker logs`. A lane that does not exist is added to `fixit.config.json`, not run around. A reproduction beats a theory. Read ranges, not whole files. If the cluster is too wide for one worker, propose a split.
4. **Decisions.** The worker cannot ask the owner directly. Write questions in `## Owner decisions needed` in the cluster doc: only product policy, permissions, user-impact trade-offs and scope, 1–4 per round, recommended option first, each with its consequence. Return. The lead asks the owner and records the answers in the doc. **A fresh planner** then finishes from the doc. If an answer introduces a principle, apply it across the cluster and look for code that violates it; that is often a new item.
5. **Write the plans** from templates/: `<planDir>/<CLUSTER>.md`, and per item either `<planDir>/<ID>.md` or a `## <ID>` section in the cluster doc, so `remedy brief` can extract it. Each has root cause, decision, fix, files, tests (the test that fails before and passes after, named as `pinnedBy`), acceptance and `Risk:`. Check the file does not already exist; a parallel session may own it.
6. **Record** in one `remedy batch` file: `set-plan` with path, summary and `risk`, plus `pinnedBy`, `dependsOn`, `cluster` and new items (INTAKE.md §5). `risk` chooses the build's model, so set `mechanical` only when the plan gives exact edits.
7. **Report** in at most 10 lines, and stop. The lead checks `git status --porcelain` shows only `<planDir>/` and `.remedy/`, persists owner decisions in the cluster doc, and pushes to a live tracker if one is configured. The next step is the owner's approval.

## Plan quality bar

- A stranger can build it without re-investigating: exact files, functions, data shapes, migrations, flags, and order.
- The smallest change that enforces the invariant at the last trusted decision point; name the invariant.
- Every decision traceable to the owner or to code evidence.
- Tests: the failing-before test, regression tests for the edges, and how the gate (CI) keeps it fixed.
- Interactions: which other items must land first, which plans must change when this lands.
- Out-of-scope observations go in a short "noted, not in scope" paragraph — never silently added.

## Revising a plan

If the owner changes a decision after approval, rewrite the plan doc, run `set-plan` again (approval withdrawn), and tell the owner it needs re-approval. Keep the history.
