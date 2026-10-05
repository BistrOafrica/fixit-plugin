---
description: Fill the register and tracker from tests, TODO sweeps, a findings file or a reported bug
argument-hint: "[findings.json | 'markers' | 'sweep' | a bug description]"
---
Load the `remedy` skill and follow `${CLAUDE_PLUGIN_ROOT}/skills/remedy/INTAKE.md`.

Source: "$ARGUMENTS".
- A path to a `findings.json` → §1 `import-findings`.
- `markers` → §2: `remedy scan`, triage each marker, add rows/items with `pinnedBy`.
- `sweep` → §3: TODO/stub/placeholder sweep (use an exploration subagent), add items.
- Anything else is an owner report → §4: reproduce, then file a register row and tracker item.
Always dedupe, use `remedy next-id`, keep items create-only, propose clusters, then `remedy validate` and `remedy render`. Report what was added.
