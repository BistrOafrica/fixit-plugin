# Layer · Browser end to end (Playwright)

Use a real browser for what only a browser can show: journeys across roles, access control as rendered, and **layout and rendering**. jsdom has no layout, so a component that is 0 px tall passes every unit test. CMIS's maps were blank for that reason.

## Configuration ([templates/playwright.config.ts](templates/playwright.config.ts))
- Use `workers: 1` and `fullyParallel: false` when personas or shared back-office state are involved.
- Set `retries: 1` in CI and `forbidOnly` in CI, and keep trace, video and screenshot only on failure.
- Add `webServer` entries for the front ends (Vite on fixed ports, `--strictPort`), proxying `/api` to the API under test so calls are same-origin. The suite **doesn't start the API**; it asserts the API is healthy in global setup.
- WebGL on GPU-less CI (maps, canvas): Chromium args `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`.

## Personas and global setup ([templates/global-setup.ts](templates/global-setup.ts))
- Keep one constants module with personas `{email, name, role, external}` and a `storageStatePath(persona)`.
- Global setup does the following, in order:
  1. Check API health and fail fast.
  2. Run an idempotent seed (DB-name guarded).
  3. Warm the dev servers with retries, because cold Vite optimises dependencies and reloads.
  4. **Log each persona in through the real UI** and save its `storageState`.
- Isolation from the load test: address the e2e process to a role no load bot holds, and use slugs that load-test filters don't match. The e2e suite can then run against the live load stack.

## Spec patterns
- **Journeys:** use `test.step` across two contexts (citizen applies, officer approves, citizen sees approved; request-info loop). Stamp unique values in answers (`Date.now().toString(36)`).
- **RBAC in UI and API:**
  - assert the outsider's queue in the page **and** call the API with the page's own token;
  - **wait until the right approver sees the item** before asserting the outsider sees nothing, so that "empty" means something.
- **Real layout and pixels** ([templates/render-check.ts](templates/render-check.ts)):
  - assert the bounding boxes of the element, its wrapper and the canvas match within 1px × DPR, and that the canvas backing size equals CSS size × DPR;
  - poll `canvas.toDataURL()`, downsample to 48×48 and require more than N distinct colours, so a blank render fails;
  - check both themes.
- **Network fixtures:** `context.route("https://tiles.example.org/**")` serves recorded files (record them with a script; return 204 for unrecorded tiles), so the test is deterministic offline.
- **Reproducing a reported UI bug:** before planning a fix, render the page headlessly, read `getComputedStyle` and bounding boxes, try the candidate fix in-page (`el.style.position = "absolute"`), and screenshot before and after. Measurements beat theories. For CMIS this showed the map container was 640×0 because an unlayered vendor stylesheet beat Tailwind v4's layered utilities.

## Pinning
Use `test.fixme` with a `// BUG: file:line — …` comment for journeys blocked by a known defect. See PINNING.md.
