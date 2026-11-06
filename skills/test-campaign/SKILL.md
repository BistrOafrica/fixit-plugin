---
name: test-campaign
description: 'Defect-discovery test campaign: HTTP authz, workflow simulation, k6 load, capacity, Playwright, contracts, static sweeps. Pins every bug with a ratchet test. Use for "test this system", "find bugs", "load test", "Playwright e2e", "pin known bugs". Feeds the remedy skill.'
---

# Test Campaign

Find defects by **exercising the system the way its users and its load will**, then pin each defect with a test that reports it today and turns red when it is fixed. A finding is a reproducible deviation from intended behaviour, with evidence. A missing best practice is not a finding.

The security audit reads the source for trust-boundary violations. The test campaign **runs** the system. In practice the two tend to find different defects:
- HTTP tests find auth holes.
- Workflow simulation finds routing and lifecycle bugs.
- The concurrent load lifecycle can find stale double decisions, which a single-request test cannot.
- A capacity benchmark can find O(history) scans, which an empty database hides.
- A real browser can find CSS layout bugs that make a view render blank, which jsdom cannot show.

Run both for full coverage.

## Operating modes

- **Guidance mode** (default): for a focused question ("how do I load test X", "write a Playwright spec for Y", "why does this only fail in the browser"), use the relevant companion file only. Don't build the whole harness.
- **Full campaign mode**: when asked to test the system end to end, run a campaign, or produce a test report. Run the phases below and write the artifacts. If the request could mean either, ask one question first.

## Safety (always)

- **Never run against production or shared environments.** Every harness has a database-name guard (for example, refuse unless the name ends in `_test` or `loadtest`). Load and stress profiles run only against a disposable stack on its own ports and volumes.
- Use synthetic personas and data (for example `*@example.test`), and keep secrets out of fixtures.
- Load tests can saturate a laptop. Say what the machine is, and treat the figures as a floor, not as production capacity.
- **Don't fix bugs during a campaign** unless asked. Pin them instead. Fixes go through the remedy gate.

## Campaign phases (full mode)

Each layer runs in a fresh `campaign-author`. The lead holds no test code. After the last layer, merge `campaign/layers/*.json` into `campaign/campaign-findings.json` with a script. Run tests only through `fixit test`.

1. **Reconnaissance** ([RECON.md](RECON.md)). Map the stack, entry points, roles and personas, state machines and workflows, existing tests, and how to run each part locally. Then pick the layers that apply. Output: `campaign/plan.md` (layers, the target per layer, what's out of scope).
2. **Foundations** ([FOUNDATIONS.md](FOUNDATIONS.md)). An isolated test DB with a name guard and fingerprint rebuild, a lane runner, unique-id factories, an HTTP client that acts as a user, seeded randomness, and a shared invariants module.
3. **Layer hunts**, run in this order and pinning as you go:
   - **HTTP and authorization**, [HTTP-AUTHZ.md](HTTP-AUTHZ.md): an auth matrix per endpoint, a default-deny route sweep, takeover and identity patterns, tenant isolation.
   - **Process simulation**, [SIMULATION.md](SIMULATION.md): walk every configured workflow with strategies, probes and invariants, and produce a matrix artifact.
   - **Front-end contracts**, [FRONTEND-CONTRACT.md](FRONTEND-CONTRACT.md): MSW contract tests with every unhandled request failing, plus component tests.
   - **Browser end to end**, [BROWSER-E2E.md](BROWSER-E2E.md): Playwright personas logged in through the real UI, critical journeys, RBAC checked in both the UI and the API, and real-layout and pixel checks.
   - **Load lifecycle**, [LOAD-LIFECYCLE.md](LOAD-LIFECYCLE.md): k6 actors plus simulated reviewer bots plus a ledger plus a DB-trigger log plus a reconciler, with smoke, load, stress, spike and soak profiles.
   - **Capacity and growth**, [CAPACITY.md](CAPACITY.md): a demand model, offered-versus-achieved throughput, latency against history size to detect O(n) paths, and a verdict.
   - **Static sweeps**, [STATIC-SWEEPS.md](STATIC-SWEEPS.md): type errors as a bug list, config and catalog integrity, mock or demo leaks, fail-open flags, and boot under production rules.
4. **Pinning** ([PINNING.md](PINNING.md)). Every confirmed defect gets a marker test (`todo`, `it.fails`, `test.fixme`, a `KNOWN_*` ratchet entry, or `known-issues.json`) whose message names the defect and its location. CI stays green and the list can only shrink.
5. **Findings** ([REPORTING.md](REPORTING.md)):
   - write `campaign/campaign-findings.json` against [campaign-findings.schema.json](campaign-findings.schema.json);
   - write `campaign/REPORT.md`;
   - optionally publish a campaign report page;
   - hand off to remedy with `remedy import-campaign campaign/campaign-findings.json`.

A campaign ends in one of two states: every selected layer has run and all its findings are pinned and reported, or the report says exactly which layers didn't run and why. Never stop mid-layer.

## Principles

- **Each layer must earn its place.** Prefer the cheapest layer that can observe the defect, and escalate when that layer *can't* see it. jsdom has no layout, a single request can't show a race, and an empty database can't show an O(n) scan.
- **Determinism.** Seed every random choice from stable parts (`hashSeed(runId, actor, entity, step)`) so a failing run replays exactly.
- **Invariants over examples.** Encode what must always hold, such as legal transitions, authorised deciders only, no double billing and append-only logs. Check them in simulations and in the load reconciler from the same module.
- **Negative probes.** At every step, the wrong person tries the action. Any 2xx is a finding.
- **Confirm before positive assertions settle.** Before asserting "outsider sees nothing", wait until the right person *does* see the item.
- **A known bug excuses only the outcome it explains.** Partition violations into known and unknown, and fail on unknown.
- **Evidence.** Each finding has a reproduction: the test name, the seed, the request, a screenshot, or a query. A finding with no reproduction is a lead, not a finding.
- **Report the harness's own limits** (hybrid mode, flaky reruns, a laptop instead of production hardware) next to the results.
