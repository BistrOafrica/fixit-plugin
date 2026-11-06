---
description: Fill the register and tracker from tests, TODO sweeps, a findings file or a reported bug
argument-hint: "[findings.json | 'markers' | 'sweep' | a bug description]"
effort: low
---
Load the `remedy` skill and follow `${CLAUDE_PLUGIN_ROOT}/skills/remedy/INTAKE.md`.

Source: "$ARGUMENTS".
- A path to a `findings.json` (audit) or `campaign-findings.json` (campaign) → §1 or §1b: import by script, with `remedy import-findings` or `remedy import-campaign`.
- `markers` → §2: `remedy scan`, then spawn `remedy-triager` for the markers.
- `sweep` → §3: spawn `remedy-triager` for the TODO/stub/placeholder sweep.
- Anything else is an owner report → §4: reproduce (a `remedy-investigator` if code must be read), then file a register row and tracker item.
Spawn with the agent, model and effort from `remedy route --role triager`; the prompt is the path of INTAKE.md, the source, and one sentence of job. Report its reply. Always dedupe, use `remedy next-id`, keep items create-only, then `remedy validate` and `remedy render`.
