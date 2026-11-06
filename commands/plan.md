---
description: Plan one item or cluster in a fresh Opus worker (writes plans, never code)
argument-hint: "<ID> | cluster <CLUSTER> | next"
effort: low
---
Load the `remedy` skill. Target: "$ARGUMENTS". `next` is the next unplanned cluster by wave order, then dependency; say which you picked. You hold no code.
1. Resolve the target to a cluster id and its item ids, and take the route with `remedy route --role planner`.
2. Follow the lead's steps in `${CLAUDE_PLUGIN_ROOT}/skills/remedy/PLANNING.md`: `remedy stage <ids> planning`, then spawn the planner with only the cluster id and the absolute path `${CLAUDE_PLUGIN_ROOT}/skills/remedy/PLANNING.md`, with the model and effort from the route.
3. The planner returns decisions under `## Owner decisions needed` in the cluster doc. Ask the owner each one, recommended option first, and write the answers into the doc. Then spawn a fresh planner to finish; never resume the first.
4. Check `git status --porcelain` shows only `<planDir>/` and `.remedy/`, then report in at most 10 lines. Do not change product code. Do not approve: the next step is the owner's approval.
