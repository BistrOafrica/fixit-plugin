---
description: Build approved items in fresh workers, on the model each item's risk requires
argument-hint: "<ID> [<ID> …] | cluster <CLUSTER>"
effort: low
---
Targets: "$ARGUMENTS", in the cluster's build order. You hold no code. Follow `${CLAUDE_PLUGIN_ROOT}/skills/remedy/BUILD.md`.
For each: `remedy brief <ID>`. Exit 2 means tell the owner what is missing and skip it.
If the owner gave a budget: run `remedy run <ID> --max-budget-usd <N>` in the background, at most 3 at once. Otherwise spawn the agent the brief's `route:` line names, with its model and effort. Prompt: "Build <ID>. Start with: remedy brief <ID>". Nothing else.
On stuck: `remedy escalate <ID> --reason "..."`, then a fresh worker. On stuck again: `remedy stage <ID> blocked`, ask the owner. On plan-drift: ask the owner. On exit 5 from `remedy run` (a `GATE:` line): stop the wave and show the owner that line. Start nothing else.
After the cluster: `remedy-tester` for the full lane in the background, then `remedy-reviewer` if it is security-sensitive. An item built by `remedy run` is on `fix/<id>` in `.fixit/worktrees/<ID>`: run its full lane there, and give the reviewer `<base>..fix/<id>`. Report per item in one line: status, commit, pinned test.
