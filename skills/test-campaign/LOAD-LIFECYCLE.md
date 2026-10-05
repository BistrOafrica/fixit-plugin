# Layer · Load lifecycle (k6 + simulated back office + reconciler)

A throughput test asks how many requests per second. A **lifecycle** test asks whether every item that entered the system under concurrency finished correctly. Applicants (k6) file real work, simulated officers (bots) decide it through the public API, and a reconciler proves the outcome against the database. In CMIS only this layer exposed decisions accepted on already-decided items and approvals with an open change request.

## Stack ([templates/loadtest/](templates/loadtest/))
- A separate compose project with its own ports, DB and volumes, so it never touches dev data.
  - The app runs as in production (`NODE_ENV=production`), with only the switches a disposable stack needs: simulated payments, and a raised auth rate limit because every virtual user logs in from one IP.
  - Postgres runs with `shared_preload_libraries=pg_stat_statements` and enough `max_connections`.
  - Set CPU and memory limits on the app containers.
- A single-origin gateway (nginx or HAProxy) routes `/api`, `/admin` and `/`, the way production does.
- Runner services (`seed`, `sim`, `k6`, `reconcile`) sit under a compose profile, with the load-test code mounted so it changes without a rebuild.
- Pipeline: `lt-up → lt-seed → lt-sim → lt-k6 → lt-reconcile`. The exit code is the reconciler's verdict.

## Seed
- Idempotent upserts of applicants (each owning the orgs they need), one bot account per role the workflows wait on, and supervisors.
- Write fixtures (`applicants.json`, `bots.json`, `services.json`, `credentials.json`) for k6 and the simulator.
- Guard on the DB name.
- **Audit triggers ([templates/loadtest/audit-triggers.sql](templates/loadtest/audit-triggers.sql)), installed only on the load stack:** AFTER INSERT/UPDATE triggers append to `lt_entity_log` (old/new status and version, `form_changed`, lengths of event arrays) and `lt_node_log` (workflow node and status changes). This is the ground truth the reconciler replays.

## k6 actors ([templates/loadtest/k6-main.ts](templates/loadtest/k6-main.ts))
Three scenarios:
- **applicants**: log in, browse, generate the form with the *shared generator*, upload, pay, submit, register with the simulator's ledger, and at `probeRate` probe that editing after submit returns 403 (the `lt_probe_failed` Rate).
- **followups**: lease due ledger entries, answer change requests, pay invoices, report observations.
- **browsers**: read traffic.

Also:
- Tag requests with route templates (`name`), so percentiles group per endpoint.
- Clear the token cache on a 401, because long runs outlive the access token.
- Seed with `hashSeed(RUN_ID, vu, iter, slug)`.
- Write `k6-summary.json` from `handleSummary`.

## Officer simulator ([templates/loadtest/sim-policy.ts](templates/loadtest/sim-policy.ts))
- One bot per officer account. Each polls its own inbox through the API, claims (a 403 or 404 means a peer won the race), thinks (lognormal), then decides or completes the task. **Nothing goes through the DB.**
- **Decision policy** (JSON): weights for approve, reject and request_info; the resolution order `byService.byNode > byService.default > byRole > default`; `maxRequestInfoPerSubmission`; allocation round-robin or random. Each draw is seeded with `hashSeed(policySeed, submissionId, nodeId, visit)`, so a configuration replays exactly.
- **Probes:** a bot sometimes tries a stage not addressed to it, and any acceptance is recorded in `probeViolations`.
- **Supervisors** clear only stages the seed marked unactionable, and every clearance is counted.
- **Ledger:** an in-memory map with every mutation appended to `ledger.ndjson` and replayed on restart. Leases use `nextCheckAt/leasedUntil`.
- **Control plane:** `/metrics`, `/summary`, `/preflight` (eligible processes), `/ledger`, `/ledger/due`, `/ledger/stats`. Rewrite `sim-summary.json` every tick, so a killed run still leaves a summary.

## Reconciler ([templates/loadtest/reconcile.md](templates/loadtest/reconcile.md))
1. **Drain:** wait until no ledger entries are open, while acting as applicants for late change requests and invoices.
2. **What users saw:** flag any item seen leaving a terminal state, and turn accepted probes into violations.
3. **What the DB says:**
   - ledger parity in both directions (lost responses, ghost entities);
   - replay the trigger logs through the **shared invariants**;
   - SQL checks such as a payment spent twice;
   - stuck items with the node they wait on;
   - the top statements from `pg_stat_statements`.
4. **k6 verdict:** the failed thresholds.
5. **Verdict:** partition violations against `known-issues.json` (`{invariant, match, issue}`). The run passes only with no unknown violations, nothing stuck and no failed thresholds.

Outputs go to `out/<RUN_ID>/`: `report.{json,md}` (per process: filed, approved, rejected, open, and p50/p95 time to terminal), the summaries, the ledger and the decisions.

## Profiles ([templates/loadtest/profiles/](templates/loadtest/profiles/); decision policy in [decision-policy.json](templates/loadtest/decision-policy.json))

| Profile | Shape | Pass bar |
|---|---|---|
| smoke | each eligible process × 2 (shared iterations), a few VUs, fast think time | **100% terminal, zero unknown violations**, `checks > 99%`, probes 0 accepted |
| load | ramp to the expected peak, hold 15 min | p95 targets per route |
| stress | +step every 3 min until thresholds abort (`abortOnFail`, `delayAbortEval`) | the rate at abort is the capacity finding |
| spike | low → 50× → low | recovers, no stuck items |
| soak | low rate for hours | no growth in latency or memory, no stuck items |

Run smoke in every campaign. Run the others on hardware that represents production, and in CI nightly with `workflow_dispatch` inputs for profile and size.
