# Phase 5 · Findings and report

## `campaign/campaign-findings.json`
An array validated against [campaign-findings.schema.json](campaign-findings.schema.json). Each entry:

```json
{
  "fingerprint": "http/auth/register-existing-email",
  "verdict": "confirmed",
  "title": "Registering with an existing email returns that account's session",
  "detail": "POST /auth/register upserts by email and issues a session without a credential, staff accounts included.",
  "impact": "Account takeover of any user whose email is known.",
  "severity": "critical",
  "layer": "http-authz",
  "category": "Security",
  "component": "Auth",
  "location": ["src/modules/auth/auth.controller.ts:41", "auth.service.ts:328"],
  "reproduction": "auth.test.ts › register with an existing email (todo)",
  "pinnedBy": "src/modules/auth/__tests__/auth.test.ts:411 (todo)",
  "kind": "bug"
}
```

- `verdict`: `confirmed`, or `lead` (observed but not yet reproduced deterministically, which gets no severity).
- `layer`: `http-authz | simulation | load-lifecycle | capacity | browser-e2e | frontend-contract | static`.
- `kind`: bug | perf | gap | debt | test-gap.
- The `fingerprint` must be stable across runs. Reuse it so re-runs dedupe.
- Severity uses remedy's PROTOCOL.md scale. For capacity blockers use `high` and kind `perf`.

Hand off with:
```
node <remedy>/scripts/remedy.cjs import-campaign campaign/campaign-findings.json
```

## `campaign/REPORT.md` (and an optional published report page)

Sections in this order, with numbers taken from the run artifacts, never estimated:

1. **Verdict figures**: tests built and run; defects by severity; critical count; coverage before → after.
2. **Defects**: a table of severity, finding, the layer that caught it, and where. Add one chart by severity and one by layer, which shows why each layer earned its place.
3. **Suites**: per suite, how many pass, how many are pinned, how many are not applicable, with a note.
4. **Coverage**: backend before → after, by area; the front ends.
5. **Simulation matrix**: process × path cells (pass, bug, n/a, blocked by config, supervisor needed).
6. **Load lifecycle**:
   - items submitted, terminal and stuck;
   - info requests answered and payments settled;
   - probes refused;
   - thresholds passed;
   - known versus unknown violations;
   - latency per endpoint (p50/p95/p99, log scale);
   - top DB statements;
   - time to terminal per process.
7. **Capacity**: the demand model table; measured versus demand; growth curves; verdict and blockers.
8. **Browser e2e**: each spec and its result.
9. **Method and caveats**:
   - what ran where (isolated DB, hybrid mode, Vite servers);
   - flaky reruns;
   - restarts;
   - hardware;
   - which profiles did **not** run;
   - CI workflows not yet run on the host.

Close with how to re-run (make targets and commands) and where artifacts live (`coverage/`, `loadtest/out/<run>/`, `playwright-report/`).
