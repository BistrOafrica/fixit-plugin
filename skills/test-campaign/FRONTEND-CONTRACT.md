# Layer · Front-end contracts and components (Vitest + MSW)

These tests prove that each front-end API module sends exactly what the backend expects and decodes exactly what it returns. Typical defects at this layer: envelope decoding, missing request fields, swallowed errors, 401 handling.

## Setup ([templates/msw-server.ts](templates/msw-server.ts))
- Start `server.listen({ onUnhandledRequest: "error" })`, so **any unstubbed call fails the test**.
- Keep the baseline handler list empty. Each test registers what it needs.
- `stubApi(method, path, response | fn, {status})` registers a one-test handler and returns a live `CapturedRequest[]` (method, pathname, search, params, parsed body, headers).
- After each test: cleanup, `resetHandlers`, clear local and session storage, restore real timers.
- Add jsdom polyfills (ResizeObserver, IntersectionObserver, matchMedia, pointer capture, scrollTo, `createObjectURL`). Give heavy libraries (maps, charts) recording stand-ins.
- Pin `API_BASE` in the test env so it matches the stubs.

## Contract tests (`*.contract.test.ts`)
- One file per API module, with a header naming the backend controller or schema it mirrors.
- `wire*()` fixture builders with overrides model the **server's** shapes, in snake_case, envelopes and all.
- For each function, assert the request (path, method, body, query) **and** the decoded result. Include edge envelopes: `{data: null}`, empty lists, error bodies `{message, errors}`, 401, 403, 422 and 500.
- Write documented gaps as `as never` plus a NOTE, and known bugs as `it.fails` (a self-ratchet: it turns red once the bug is fixed).

## Component tests
- `renderWithProviders(ui, {route, path, session})` with a `LocationProbe` (`data-testid="location"`) to assert redirects.
- Target the flows with consequences: sign-in errors shown inline, MFA branches, decision forms, validation (0 isn't "empty"; regexes have no `/g` state), hidden-required fields, drafts actually saved.
- **Know the limits.** jsdom has no layout, CSS cascade or WebGL. For anything visual, escalate to BROWSER-E2E.
