# fixit-plugin

A Claude Code plugin that runs a **gated remediation programme** on any codebase: find problems, register them, plan each fix deliberately, get an owner's approval, then build test-first and keep the record honest.

It combines three skills:

- **`security-audit`** (vendored from [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill), unmodified). It runs a source-first, adversarially validated security audit and produces `findings.json`.
- **`test-campaign`** runs the system the way its users and its load will, and finds what a source audit can't see. It provides:
  - an isolated-DB integration harness, HTTP authorization matrices and a default-deny route sweep;
  - deterministic simulation of every workflow, with invariants and negative probes;
  - a **k6 load lifecycle**: applicants in k6, simulated officers deciding through the API, a DB-trigger audit log and a reconciler that proves every item ended correctly;
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
| `/fixit-plugin:init [title]` | Create the ledger (`.remedy/`) and plan directory in this repo |
| `/fixit-plugin:audit [profile]` | Run the security audit, then import confirmed findings and validation leads |
| `/fixit-plugin:test [layers] [profile]` | Run the test campaign (HTTP authz, simulation, k6 load lifecycle, capacity, Playwright, contracts, static sweeps), pin the defects, import them |
| `/fixit-plugin:hunt` | Run both: security audit and test campaign into one register, with overlaps merged |
| `/fixit-plugin:intake <source>` | Import from a `findings.json`, test markers (`markers`), a TODO sweep (`sweep`), or a bug you describe |
| `/fixit-plugin:plan <ID \| cluster X \| next>` | A planning run that investigates, asks you the decisions, writes the plans and moves items to plan review. It never writes code. |
| `/fixit-plugin:build <ID …>` | Builds approved items only, test-first, flipping the pinned test and moving each item to in review and then done |
| `/fixit-plugin:status` | Shows what is waiting for your approval, what is approved, what is building, and any validation errors |
| `/fixit-plugin:sync` | Reconciles the local ledger, the register and the live page |
| `/fixit-plugin:publish` | Publishes a live claude.ai tracker page where editors approve plans with a button |

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

The CLI is `skills/remedy/scripts/remedy.cjs`, which needs Node 18 or later and no dependencies. Run `node remedy.cjs help` for its options. Tests: `node --test skills/remedy/scripts/remedy.test.cjs` and `node --test skills/test-campaign/templates/templates.unit.test.ts` (Node ≥ 23).

## Install

```
claude plugin marketplace add /path/to/fixit-plugin
claude plugin install fixit-plugin@bistroafrica
```

## Origin

This plugin is abstracted from the CMIS remediation programme (2026): 160+ items across 27 clusters, planned by several Claude sessions working in parallel under one owner-approval gate.

## Licence

MIT. `skills/security-audit` is © Cloudflare, Inc. under MIT; see `THIRD_PARTY_NOTICES.md`.
