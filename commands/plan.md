---
description: Run a gated planning run for an item or a cluster (writes plans, never code)
argument-hint: "<ID> | cluster <CLUSTER> | next"
---
Load the `remedy` skill and follow `${CLAUDE_PLUGIN_ROOT}/skills/remedy/PLANNING.md` exactly.

Target: "$ARGUMENTS" (`next` = the next unplanned cluster by wave order, then dependency).
- Investigate against current code and reproduce where cheap; check other plans for overlap.
- Ask the owner only the decisions that are theirs, recommended option first.
- Write `<planDir>/<CLUSTER>.md` and `<planDir>/<ID>.md` per item from `templates/` (check each file doesn't already exist).
- Record with `remedy set-plan`, file any new finds, `remedy validate`, `remedy render`, mirror to the live artifact if in use.
- Do not change product code. Do not approve. End with the report described in SKILL.md.
