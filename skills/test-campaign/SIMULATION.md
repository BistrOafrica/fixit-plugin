# Layer · Process simulation (walk every workflow)

When behaviour lives in configuration (workflows, approval chains, BPMN, state charts, catalogs), example tests cover a tiny fraction of it. Generate a walk for **every** configured process and **every** path, run it through the public API, and check invariants and probes at each step. This kind of walk tends to surface allocation, routing, scoping and stranding bugs that hand-written examples miss.

## Deterministic engine harness ([templates/engine-harness.ts](templates/engine-harness.ts))
- Swap the job dispatcher for an in-memory queue of `{job, dueAt, seq}` with a **virtual clock**.
- `drain()` runs the earliest due job (ties broken by `seq`) and throws after `maxJobs` jobs ("a workflow is looping").
- `advanceTime(ms)` moves the clock, then drains. Timers run through the real worker handler.
- Trace every transition `{fromNode, toNode, fromStatus, toStatus}`. No Redis, no worker process, and identical every run.

## The walker ([templates/workflow-walker.ts](templates/workflow-walker.ts))
1. **Submit** exactly as the real client does: fetch the definition, generate answers with the shared generator (seed `hashSeed(slug)` so every path files the same answers), upload, quote, pay up front if required, submit.
2. **Loop** up to `maxSteps`:
   - settle; stop when terminal;
   - at a payment node, the submitter pays;
   - at an automated node, advance the clock (e.g. 8 days); if nothing moved, record **stuck**;
   - at a human node, build `Parked {nodeId, type, visit, outcomeOptions}` and ask the **strategy** for a decision.
3. **Strategies:** `approveAll`, `rejectAt(first|last)`, `requestInfoAt(node)` (first visit only; the submitter then re-answers the requested fields and resubmits), `outcomeAt(node, value)` for each option of each decision task.
4. **Probes before each decision**, each expected to be refused (401, 403 or 404):
   - an outsider of a different role tries to decide;
   - the submitter tries to decide their own item;
   - the submitter tries to edit while it is under review.
5. **Supervisor fallback.** If the addressed role gets 403, or no user can hold it, a supervisor decides and the walk records `supervisorOverrides`. **Each override is a finding**: a stage nobody normal can act on.
6. **After the walk**, check:
   - the invariants;
   - `terminal` (the workflow finished but the entity didn't);
   - `orphaned-by-failure` (the instance failed silently);
   - domain rules such as "an allocation is honoured by the allocated stage".

`ReviewerPool` creates lazily one reviewer per role, one supervisor and one outsider.

## Invariants ([templates/invariants.ts](templates/invariants.ts))
- `checkTransitions`: every consecutive status pair is in `ALLOWED_TRANSITIONS`, and terminal statuses have no outgoing transitions.
- `checkStageOrder`: each node move is reachable along graph edges (BFS), since one advance can run several nodes.
- `checkAuthorizedDecisions`: decisions come from the stage's role, its allocated user, or a declared manager.
- `checkIntegrity`: at most one charge per payment node, no payment spent twice, at most one issued document, and a document only if approved.
- `checkNoEditAfterSubmit` and `checkAppendOnly` (event and correction logs never shrink).

## The matrix test ([templates/matrix.sim.test.ts](templates/matrix.sim.test.ts))
- Generate a `describe` per process and a test per path, using top-level `await` over the catalog.
- Derive the non-happy paths from the happy path's stages, and skip them when the happy path fails.
- Map known violations to `todo` by invariant name. Fail on **unknown** violations. A known bug excuses only the outcome it explains.
- Write `coverage/workflow-matrix.json` (process × path → pass, bug, n/a, blocked, supervisor), and have CI summarise it as a table.
- Provide knobs `SIM_PROCESSES=a,b` and `SIM_MAX_PATHS` for focused reruns.

## Static checks on the configuration (cheap and run first)
- Every stage is addressed to a role that can act and has holders.
- No required choice field without options.
- Every branch has an edge for each outcome.
- No templated role left unrendered.
- Tokens are read after they are set.

Implement these as ratchets (PINNING.md). Process definitions that can't be filled or walked are themselves findings.
