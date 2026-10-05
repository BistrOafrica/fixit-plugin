# Phase 2 · Foundations

Build these once. Every later layer depends on them. Templates are in [templates/](templates/).

## Isolated test database ([templates/setup-db.ts](templates/setup-db.ts))
- **Name guard.** Refuse any database whose name doesn't match `/_test$/`. Re-assert the guard at import time in every harness module that touches the DB, because a wrong env var must never reach production data.
- **Fingerprint rebuild.** Compute sha256 over the schema, the migrations and the seed or catalog sources, and store it in a meta table inside the test DB. If it changed: drop with FORCE, create, migrate, seed from the committed source of truth, and store the new hash. If unchanged: skip, so runs stay fast. `--force` rebuilds anyway.
- **Seed from the same source production uses** (catalogs, fixtures), never hand-made SQL.

## Lane runner ([templates/run-lanes.ts](templates/run-lanes.ts))
- Assign lanes by filename suffix:
  - `*.unit.test.*`: no DB, run fully parallel.
  - `*.test.*`: integration, against the DB, concurrency 1 (or schema-per-worker).
  - `*.sim.test.*`: simulations, concurrency 1.
- Give child processes a fixed env: `DATABASE_URL=TEST_DATABASE_URL`, `NODE_ENV=test`, silent logs, raised rate limits, test secrets, zero artificial delays, and output directories under `.run/`. The runner's env must override `.env` files.
- Set a per-test timeout and force exit, because a stray open handle should fail loudly as a timeout instead of hanging CI.
- Coverage: c8 or istanbul with `all: true`, excluding tests and harness. Record the "before" number first, so the report can show the delta.

## Factories and uniqueness
- `uniq(prefix)` returns `prefix-<pid36>-<time36>-<counter36>`. Every row is unique, so tests never truncate and never collide.
- Factories write the *scene* directly through the ORM (users with roles, orgs, workflows, forms, services, settled payments). The *behaviour under test* is always exercised through the public interface (HTTP).
- `makeUser({roles})` refuses unknown roles. Use a low bcrypt cost and one shared test password.

## Acting as a user ([templates/http-client.ts](templates/http-client.ts))
- Run supertest (or the language's equivalent) against the real app object, with no port.
- `as(user)` mints a token directly (skipping login), `anon()` sends none, and `withToken(t)` sends expired, tampered or wrong-type tokens.

## Seeded randomness ([templates/rng.ts](templates/rng.ts))
- Use mulberry32 `rng(seed)` with `next/int/pick/chance`, and `hashSeed(...parts)` (FNV-1a).
- Keep this module dependency-free, so k6, node:test and Vitest can all import it.

## Shared modules used by several layers
- **Data generator.** Produce valid inputs from the system's own form or schema definitions, honouring required fields, visibility conditions, cascading lists, min/max and length rules, and file rules (real magic bytes such as `%PDF-` and PNG). Offer `minimal | full | random` variants, and report what it can't generate instead of faking it. One generator is shared by the simulations, k6 and front-end tests.
- **Invariants module** ([templates/invariants.ts](templates/invariants.ts)). Pure functions that return `Violation[]`. The simulations *and* the load reconciler both use it.
