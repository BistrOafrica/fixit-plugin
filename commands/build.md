---
description: Build approved plans — gate-checked, test-first, flips the pinned test, mirrors the register
argument-hint: "<ID> [<ID> …] | cluster <CLUSTER>"
---
Load the `remedy` skill and follow `${CLAUDE_PLUGIN_ROOT}/skills/remedy/BUILD.md` exactly.

Targets: "$ARGUMENTS". For each, in the cluster's build order:
1. `node ${CLAUDE_PLUGIN_ROOT}/skills/remedy/scripts/remedy.cjs show <ID>` — refuse to build if `plan.approvedAt` is empty; tell the owner what is missing.
2. `remedy stage <ID> building`, re-read the plan against current code, make the pinned test fail for the right reason, implement, flip the marker in the same change, run the verification the plan names.
3. Scoped commits per the repo's conventions; never commit unrelated changes.
4. `remedy stage <ID> in_review` (and `done` once merged), `remedy validate`, `remedy render`, mirror to the live artifact if in use.
Report per item: changes, the flipped test, verification output.
