# Layer · Static sweeps

These are cheap and fast, and they find real bugs that the other layers walk past. Run them first, and again after the other layers.

## Type errors are a bug list
- Run the type checker on every package (`tsc -b`, `mypy`, `go vet`) and classify each error:
  - **runtime crash**: an unimported identifier, a component passed where an element is expected, a missing case in an exhaustive map;
  - **data loss**: a value silently degraded or dropped, e.g. an allow-list missing a type;
  - **dead code**: an orphaned file importing a deleted module;
  - **noise**.
- For each crash or data-loss error, reproduce the user-visible effect (a component test or e2e step), then file it.
- If CI runs the checker with `continue-on-error`, that is itself a finding.

## Configuration and catalog integrity
Encode the configuration's rules as tests over the committed config, using ratchets (PINNING.md):
- every stage addressed to an actionable role that has holders;
- required choice fields have options or a reference list;
- each branch outcome has an edge;
- no unrendered `{{template}}` roles;
- tokens read after they are set;
- labels match the roles they name.

## Mock, demo and fail-open leaks
- Find runtime switches that select mock or demo data (`USE_MOCKS`, `AUTH_ENABLED`, `DEMO_MODE`). A switch that **defaults to mock when unset** is a finding.
- Grep production paths for mock imports: mock records merged into real results, mock users offered in pickers, fabricated fallbacks on error. Prove each by reading the code path in real mode.
- Check production builds for sentinel strings from seed data.

## Deploy and boot
- Build the images and boot the stack under **production rules**, with the start-up safety checks active: does it start?
- Check that installs use the lockfile and that the runtime user isn't root.
- Look for dead legacy deployment files, and for tracked env files carrying bypass flags or passwords.

## Repository sweep
- TODO, FIXME, "not yet available" and "coming soon" placeholders.
- Stubs returning `[]` or throwing.
- Copies marked "keep in sync" that have drifted.
- Linters that are configured but not installed.

These become tracker items. They become register defects only when they cause wrong behaviour today.
