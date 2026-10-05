---
description: Reconcile the local ledger, the register and the live artifact pages
---
Load the `remedy` skill (BACKENDS.md).
1. If a live artifact is configured, pull it: ArtifactData `list` with `out_dir` for `items`, `bugs`, and `get meta/protocol`, then `remedy import-artifact --items … --bugs … --meta …`. Owner approvals made in the page are the source of truth for `plan.approvedAt`.
2. `remedy sync-register` to mirror stages onto register rows; `remedy validate`.
3. Push local changes back to the artifact with `if_version` (re-read and merge on conflict).
4. `remedy render`. Report what changed in each direction.
