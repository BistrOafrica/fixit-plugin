# Build sessions

Trigger: "build SEC-01", "implement the approved CRYPTO plans", "start building in order". A build session changes product code for **approved items only**.

## Steps

1. **Check the gate.** `remedy show ID` → `plan.approvedAt` must be set and the stage `approved` (or `building` if resuming). If not, stop and tell the owner what is missing. Check `dependsOn`: an item whose dependencies are not done is built after them unless the plan says otherwise.
2. **Start.** `remedy stage ID building --note "<branch>"`. (Mirrors the register row to in_progress.)
3. **Re-read the plan** and verify it still matches the code (other merges may have moved things). Small drift: adapt and note it. A material difference (the fix no longer fits, a decision is invalidated): stop, update the plan, `set-plan` (approval withdrawn), and ask for re-approval.
4. **Test first.** Make the pinned test fail for the right reason (or write the planned test), then implement until it passes. Flip the marker (`it.fails` → `it`, remove the `KNOWN_*` entry, delete `todo`) **in the same change**.
5. **Verify.** Run the lanes the plan names plus the project's standard checks (types, lint, unit, integration, e2e where touched). Report failures faithfully with output.
6. **Commit** in scoped commits following the repository's conventions (respect any rule about attribution and about not committing other sessions' work). Never commit unrelated working-tree changes.
7. **Record.** `remedy stage ID in_review --note "PR #… / commit …"` once written; `remedy stage ID done --note "merged in …"` once merged. Each call mirrors the register (fix_in_review, fixed). Run `remedy validate` and, for the artifact backend, mirror the item and register row.
8. **New finds** while building → INTAKE.md §5, not a silent fix.

## Order

When the owner says "build in order", follow the cluster's build order, one item per commit series, and stop between items only for failures or decisions. Report after each item: what changed, the flipped test, verification results.
