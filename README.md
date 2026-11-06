# fixit-plugin

A Claude Code plugin that runs a **gated remediation programme** on any codebase: find problems, register them, plan each fix deliberately, get an owner's approval, then build test-first and keep the record honest.

It combines three skills:

- **`security-audit`** (vendored from [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill), unmodified). It runs a source-first, adversarially validated security audit and produces `findings.json`.
- **`test-campaign`** runs the system the way its users and its load will, and finds what a source audit can't see. It provides:
  - an isolated-DB integration harness, HTTP authorization matrices and a default-deny route sweep;
  - deterministic simulation of every workflow, with invariants and negative probes;
  - a **k6 load lifecycle**: submitters in k6, simulated reviewers deciding through the API, a DB-trigger audit log and a reconciler that proves every item ended correctly;
  - capacity and growth curves that detect O(n) paths;
  - **Playwright** journeys with personas logged in through the real UI, RBAC checked in both UI and API, and real-layout and pixel checks;
  - MSW contract tests and static sweeps (type errors as a bug list, mock leaks, config integrity, boot under production rules).

  Every defect is pinned by a ratchet test that turns red when the bug is fixed. Copy-and-adapt templates are included.
- **`remedy`** takes those findings, failing or pinned tests, TODO sweeps and owner reports, and runs them through a bug register and a tracker:

```
intake ─▶ register + tracker ─▶ planning run (per cluster) ─▶ plan review ─▶ OWNER APPROVAL ▸ build ─▶ in review ─▶ done
          (confirmed defects)     plans in docs/remediation/                      (gate)        flips the pinned test,
                                  owner decisions recorded                                      mirrors the register
```

## Commands

| Command | What it does |
|---|---|
| `/fixit-plugin:init [title]` | Create the ledger (`.remedy/`) and plan directory, and propose the project settings from `remedy init --settings` |
| `/fixit-plugin:audit [profile]` | Run the security audit (hunters on `audit-hunter`, verifiers on `audit-verifier`), then import confirmed findings and validation leads. Use a fresh session |
| `/fixit-plugin:test [layers] [profile]` | The **discovery campaign** (HTTP authz, simulation, k6 load lifecycle, capacity, Playwright, contracts, static sweeps): one fresh `campaign-author` per layer, defects pinned and imported. It is not the test runner; see `fixit test` below. Use a fresh session |
| `/fixit-plugin:hunt` | Audit in this session, then a handoff to a fresh `/fixit-plugin:test` session, then `/fixit-plugin:intake` to merge overlaps |
| `/fixit-plugin:intake <source>` | Import from a `findings.json`, test markers (`markers`), a TODO sweep (`sweep`), or a bug you describe; a `remedy-triager` does the reading |
| `/fixit-plugin:plan <ID \| cluster X \| next>` | A planning run in a fresh Opus worker: investigates, returns the decisions for you, writes the plans and moves items to plan review. It never writes code |
| `/fixit-plugin:build <ID …>` | Builds approved items only, in fresh workers on the model each item's risk requires, test-first, flipping the pinned test |
| `/fixit-plugin:status` | Shows what is waiting for your approval, what is approved, what is building (one model turn) |
| `/fixit-plugin:sync` | Reconciles the local ledger, the register and the live page, by script |
| `/fixit-plugin:publish` | Publishes a live claude.ai tracker page where editors approve plans with a button, sending only changed documents |
| `/fixit-plugin:usage` | Shows where tokens went and what was wasted, from the session transcripts |
| `/fixit-plugin:handoff [next step]` | Writes `.remedy/handoff/<time>.md`, so a fresh session can take over from `remedy handoff --latest` |

## Agents

`remedy-coordinator` (start a session with `claude --agent fixit-plugin:remedy-coordinator`), `remedy-triager`, `remedy-investigator`, `remedy-planner`, `remedy-builder`, `remedy-tester`, `remedy-reviewer`, `campaign-author`, `audit-hunter` and `audit-verifier`. Each sets a model alias, an effort and a turn limit in its frontmatter; `remedy route` says which to use for an item, and the lead passes it in the Agent call. A reviewer approves nothing, and no agent runs `remedy approve`.

## Running tests and reading logs: `fixit`

`fixit` (a second CLI in `bin/`) is the **test runner**, which is a different thing from the `/fixit-plugin:test` campaign. `fixit test <lane|file>` prints at most 40 lines and keeps the full output in `.fixit/`; `fixit logs <source>` does the same for logs in at most 30 lines. Agents are told to use them instead of raw `vitest`, `go test`, `make test-*` or `docker logs`; nothing enforces it, so `remedy usage --by kind` shows whether they did.

`fixit.config.json` at the repo root (commit it) names the lanes (`cmd`, `adapter`, `paths`, `lock`, `cacheable`, `bg`), `fileRules` for single test files, the `full` lane, `logs` sources, a `worktree.setup` command and `run.allow` (below). A lane that is not in it cannot be run through `fixit`: add it to the file rather than running the command raw.

## Running a build without a lead: `remedy run`

`remedy run ID[,ID] --max-budget-usd N [--max-turns N] [--model ALIAS] [--base REF] [--no-escalate] [--dry-run]` builds approved items in a fresh `claude -p` worker, in its own worktree (`.fixit/worktrees/<ID>`, branch `fix/<id>`, from `--base` or the main branch). It prints at most 10 lines and exits 0 done, 3 stuck, 4 handoff, 2 refused. There is no default budget (the flag, or `models.budgetUsd`), and at most 3 runs are active at once. A stuck worker is escalated once, in a fresh process, within the same budget; if it stops again the item goes to `blocked`. A run cut off at a limit leaves a `handoff` report written from `git diff --stat` and the last test digest.

**It never approves.** An unapproved item is refused before anything starts. Print mode cannot prompt, so the worker runs in `dontAsk` mode with an explicit list and everything else is refused rather than asked about: `remedy brief`, `stage`, `report`, `done`, `add-item`, `add-row`, `next-id`, `show`; `fixit test`, `show`, `wait`, `logs`; `git status`, `diff`, `add`, `commit`, `log`, `show`, `rev-parse`, `rm`, `mv`, `restore`; `printf`; and the file tools inside the worktree, not its `.remedy/` or `.claude/`. `remedy approve`, `set-plan`, `route`, `request-changes` and `batch` are denied. `remedy run ID --max-budget-usd N --dry-run` prints the list for your project.

A build tool the worker needs goes in `fixit.config.json` as `"run": { "allow": ["Bash(go vet:*)", "Bash(make lint)"] }`. These rules are read from the main checkout, and a rule that is not a `Bash(...)` rule, names the ledger, or is a wildcard over something that can run anything (`Bash(node *)`, `Bash(git *)`) stops the run. Tests need no rule: they go through `fixit test` and its lanes. A lane a worker adds to `fixit.config.json` would run, so the run's output and report say so plainly when the run changed that file, and the reviewer should read that diff before trusting a green run.

Reports (`.remedy/runs/<ID>.md`) and handoffs go in git with the ledger, if your project tracks it. Raw results (`.remedy/runs/*.json`) are kept out by a one-line `.remedy/.gitignore`; your own `.gitignore` is not touched.

## Hooks

- **`hooks/post-bash.cjs`**, an output guard on Bash results: output over 6,000 characters is replaced by a digest with the full text in `.fixit/out/`. `remedy init --settings` proposes the project settings that go with it (`BASH_MAX_OUTPUT_LENGTH`, `autoCompactWindow`).
- **`hooks/context-guard.cjs`**, on every tool call in a project with a ledger; in any other project it does nothing and creates nothing. It warns the model when the context reaches 100k, or earlier if the compaction window is lower. Under `remedy run` it warns at 55k and denies at 70k (window 120k; 35k and 50k at 100k), so the worker writes its report before compaction loses the detail. It only ever denies or adds context; it never approves a tool. Subagents are skipped.
- **`hooks/session-start.cjs`**, on resume: past 100k of context, one line advising a fresh session from a handoff.

`FIXIT_GUARD=off` turns all three off. A bug in any of them exits with no output, so it cannot block a tool.

The skills also activate from plain requests such as "security audit this repo", "plan cluster AUTH", "what's waiting for my approval?" or "build SEC-04".

## The rules it enforces

- **No build without approval.** The CLI refuses to move an item to building, in review or done unless `plan.approvedAt` is set. Revising an approved plan withdraws the approval.
- **One plan per item**, even when one run plans a whole cluster.
- **The owner decides.** Claude asks only the questions whose answer changes what gets built, with a recommended option first, and records the answers in the plans.
- **Every bug has a pinned test** that fails before the fix and passes after, and the build flips it in the same change.
- **New problems go on the record.** Anything found mid-run becomes a register row and a tracker item, never a silent fix.
- **Parallel sessions don't clobber each other:** IDs are create-only, ranges can be reserved, writes are version-pinned, and every write starts with a "look before you write" check.

## Ledger and dashboards

- **Local (default):** `.remedy/meta.json`, `.remedy/items/<ID>.json` and `.remedy/register/<KEY>.json`, with plans in `docs/remediation/`.
  - `remedy render` writes a self-contained read-only dashboard (board, table, clusters, register).
  - `remedy validate` belongs in CI.
- **Live (optional):** the same dashboard published as a claude.ai artifact backed by its database, so owners can approve plans from the browser. Use `/fixit-plugin:publish`.

The ledger CLI is `skills/remedy/scripts/remedy.cjs` and the runner is `scripts/fixit.cjs`; both need Node 18 or later and no dependencies, and `bin/` puts them on the PATH as `remedy` and `fixit`. Run `remedy help` for the options. Tests: `node --test hooks/hooks.test.cjs hooks/context-guard.test.cjs skills/remedy/scripts/remedy.test.cjs skills/remedy/scripts/run.test.cjs skills/remedy/scripts/usage.test.cjs scripts/fixit.test.cjs scripts/plugin-text.test.cjs` and `node --test skills/test-campaign/templates/templates.unit.test.ts` (Node ≥ 23).

## Install

```
claude plugin marketplace add /path/to/fixit-plugin
claude plugin install fixit-plugin@bistroafrica
```

## Licence

MIT. `skills/security-audit` is © Cloudflare, Inc. under MIT; see `THIRD_PARTY_NOTICES.md`.
