# Layer · HTTP and authorization

The cheapest layer with the highest yield. It found every account-takeover and data-exposure bug in CMIS. Run integration tests against the real app and real DB (FOUNDATIONS).

## 1. Authorization matrix per endpoint
For each route, build a table of **principal × expected result** and test every cell:

| Principal | Expect |
|---|---|
| anonymous | 401 (unless the route is public) |
| wrong role (has a session, lacks the permission) | 403 |
| right role, **other tenant / org / county** | 403 or 404, never data |
| right role, own scope | 2xx and only own-scope rows |
| external user (citizen/customer) on an internal or admin route | 403 |
| a token of the wrong type (MFA, refresh or reset token used as a bearer) | 401 |
| an expired or tampered token | 401 |

For list endpoints, assert the **contents** as well as the status: no rows outside scope, pagination present, filters applied on the server, not only in the UI. "The UI hides it" is not a control.

## 2. Default-deny route sweep ([templates/route-sweep.test.ts](templates/route-sweep.test.ts))
- Tag every authorization middleware, for example with `Symbol.for("<app>.rbacGate")`.
- Walk the router stack recursively, rebuild mount prefixes, and normalise `:param` segments. Treat a router-level `.use(gate)` as inherited by every route below it.
- Sanity-check the count (e.g. more than 400 routes) so a broken walker can't pass trivially.
- Every route must be one of:
  - gated;
  - under `PUBLIC_PREFIXES`;
  - listed in `IN_HANDLER_GUARDED` with a written reason;
  - listed in `KNOWN_UNGATED`, a ratchet.

  Anything else fails.
- A second test fails when a `KNOWN_UNGATED` entry has since been gated (PINNING.md).
- Print gaps with `console.error` before asserting, because open handles can stop the runner's diagnostics from flushing.

## 3. Identity and session patterns to probe (each became a critical finding in CMIS)
- **Registration with an existing email** returns that account's session, or overwrites its password.
- **Federated or SSO callbacks that trust a caller-supplied identity** (email in the body, unsigned blob).
- **OTP and code flows:** any code accepted; a token that is just base64 of the identifier; no attempt limit; codes reusable; a "test code" path in production builds.
- **Provisioning** that reactivates suspended accounts or links by email onto staff accounts.
- **MFA:** a challenge token usable as a bearer; TOTP replay inside its window; an MFA response treated as signed in.
- **Self-assigned roles** at signup; external roles able to grant internal roles.
- Run the **production safety checks**: boot with `NODE_ENV=production` and the demo flags, and expect a refusal.

## 4. State and integrity over HTTP
- Edit after submit; withdraw after a final decision; deciding an already-decided item; completing a task twice; a task completed by a non-assignee.
- **Concurrent writers:** fire two decisions with `Promise.all` and assert exactly one wins (lost updates on read-modify-write JSON).
- **Webhooks:** raw-body signature verification with the real content type, replay, an unknown event.
- **Readiness:** stop the dependency (Redis/DB) and expect `/readyz` to answer 503 quickly, not hang.

## Output
Pin each finding (PINNING.md) next to the passing tests in the same file, as `test(name, { todo: "BUG: file:line — …" })` or the framework equivalent, asserting the **correct** behaviour.
