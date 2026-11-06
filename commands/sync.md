---
description: Reconcile the local ledger, the register and the live artifact pages
effort: low
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/remedy/scripts/remedy.cjs sync)
---
!`node ${CLAUDE_PLUGIN_ROOT}/skills/remedy/scripts/remedy.cjs sync`

Repeat the line above. Only if a live tracker is set (`meta.publish.trackerUrl`): pull with ArtifactData `list` and `out_dir` for `items`, `bugs`, and `get meta/protocol`, then `remedy import-artifact --items … --bugs … --meta …` (owner approvals made in the page are the source of truth for `plan.approvedAt`), then push as `/fixit-plugin:publish` does.
