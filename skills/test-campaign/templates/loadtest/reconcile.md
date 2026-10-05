# Reconciler: the verdict of a load run

`reconcile [--timeout 300] [--api-only] [--no-drain-actions]`. Exit codes: 0 = pass, 1 = fail, 2 = error.

## 1. Drain
- Poll the simulator's `/ledger/stats` until no entries are open, up to the timeout.
- While waiting, act as the applicants: answer late change requests and pay invoices.

## 2. What users saw (API)
- Any entity observed **leaving a terminal status** is a violation (`transitions`).
- Turn the simulator's accepted probes into `authorized-decisions` violations.
- Count k6's `lt_probe_failed`.

## 3. What the database says (skipped with `--api-only`)
- **Ledger parity, in both directions:**
  - in the DB but never registered by k6 means a lost response, or a ghost entity created by a retry;
  - registered but missing from the DB means a lost write.
- **Replay the trigger logs** (`audit-triggers.sql`) per entity, through the **shared invariants**:
  - `checkTransitions` on the status sequence;
  - `checkStageOrder` on node moves against the entity's graph;
  - `checkNoEditAfterSubmit` on `form_changed` rows;
  - `checkAppendOnly` on consecutive event and correction lengths;
  - `checkAuthorizedDecisions` and `checkSingleDecision` from `decisions.ndjson`;
  - `checkIntegrity` from invoices, payments and certificates.
- **SQL integrity checks**, e.g. a payment intent consumed by more than one entity.
- **Stuck** entities: not terminal, with the node they wait on and the role addressed.
- **Top 10 `pg_stat_statements`** by `total_exec_time`. Look for N+1 (huge `calls` on a one-row lookup) and per-write scans.

## 4. k6 verdict
List the failed thresholds from `k6-summary.json`.

## 5. Verdict
- `partitionKnown(violations, known-issues.json)` (from `ratchet.ts`).
- `ok = unknown.length === 0 && stuck.length === 0 && failedThresholds.length === 0`.

## Outputs (`out/<RUN_ID>/`)
- `report.json` and `report.md`:
  - totals: filed, terminal, stuck, change requests answered, payments settled, probes refused;
  - **per process**: filed, approved, rejected, open, and p50/p95 time to terminal;
  - violations: unknown first, then known with their issue ids;
  - slowest statements;
  - failed thresholds.
- Also keep `k6-summary.json`, `sim-summary.json`, `preflight.json`, `ledger.ndjson` and `sim-decisions.ndjson` next to it.
