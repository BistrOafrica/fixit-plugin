# Phase 1 · Reconnaissance

Goal: choose the layers that will find defects in *this* system, and know how to run each part locally before writing any test. Use read-only exploration subagents for breadth.

## Map
1. **Stack and runtime:**
   - languages, frameworks, the DB, queues and workers, front ends;
   - how the system boots locally (compose file, make targets, env files);
   - quirks such as package-manager versions or blocked mirrors. If containers can't build, use *hybrid mode*: datastores in containers, app processes on the host.
2. **Entry points:**
   - HTTP routes, enumerated from the router so you have a count;
   - webhooks, queue consumers, cron jobs and timers;
   - CLI and admin tasks;
   - every front-end route.
3. **Principals:**
   - roles, permissions, tenant and org boundaries, geographic or office scoping;
   - external versus internal users, anonymous access;
   - service tokens and token types (access, refresh, MFA, reset).
4. **State machines:** entity statuses and their allowed transitions, workflow and process definitions (often configuration data: catalogs, BPMN, JSON graphs), payments, documents and issued records.
5. **Configuration as code:**
   - catalogs, forms, reference lists, feature flags, production-safety checks;
   - mock or demo modes and how they are switched.
6. **Existing tests:** frameworks, lanes, coverage, flakiness, and anything already pinned.
7. **Load shape:**
   - who submits what, and how often;
   - deadlines and peaks;
   - what grows without bound (history tables, audit logs, notifications).

## Choose layers

| If the system has… | Run |
|---|---|
| an HTTP API with roles or tenants | HTTP-AUTHZ (always) |
| configurable workflows, approvals, multi-stage processes | SIMULATION |
| concurrent human actors deciding on shared items | LOAD-LIFECYCLE (smoke at minimum) |
| unbounded growth, large scale, deadlines | CAPACITY |
| a browser UI with roles, or maps, canvas, or layout-heavy views | BROWSER-E2E |
| an SPA calling the API | FRONTEND-CONTRACT |
| any TypeScript, config catalogs, mock layers, a deploy stack | STATIC-SWEEPS (always; cheap) |

Write `campaign/plan.md` with:
- the layers and the targets per layer, e.g. "walk every process × 5 paths", "smoke + stress profiles", "the canvas-based views in a real browser";
- the personas;
- the environment (local Docker, hybrid);
- what's out of scope;
- the run budget.

Ask the owner one round of questions only if scope is genuinely unclear, for example "may we run stress on this machine?" or "include the third-party sandbox?".
