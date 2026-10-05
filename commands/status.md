---
description: Show the remediation programme — what waits for approval, what is approved, what is building
---
Run `node ${CLAUDE_PLUGIN_ROOT}/skills/remedy/scripts/remedy.cjs status` and `… validate` in this repository (if `.remedy/` is missing, say so and suggest `/fixit-plugin:init`). If a live artifact is configured (`meta.publish.trackerUrl`), pull owner changes first (BACKENDS.md §B step 4).

Summarise in a few lines: items waiting for the owner's approval (with plan paths), approved but not built, building, open critical items, validation errors, and the suggested next action. Re-render the dashboard (`remedy render`) and give its path.
