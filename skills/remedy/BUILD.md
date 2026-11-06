# Build sessions

A build changes product code for **approved items only**. It runs in a fresh worker (`remedy-builder` or `remedy run`), never in the lead session. The worker's steps are in `agents/remedy-builder.md`: start from `remedy brief ID`, stage to building, check the plan against the code, test first, flip the marker in the same change, scoped commits, `remedy done ID --commit <sha>`. An item whose dependencies are not done is built after them unless the plan says otherwise. New finds go through INTAKE.md §5, never a silent fix.

A material difference between plan and code (the fix no longer fits, or a decision is invalidated) stops the build with status `plan-drift`. The lead updates the plan with the owner; `set-plan` withdraws the approval. `remedy done` moves the item to in_review, or to done if merged, mirrors the register, validates and renders.

A worker's tests run as the owner. The allowlist of `remedy run` limits the commands the model calls, not what the code it writes does: that code can reach the ledger, the network and files outside the worktree, past the run's deny rules. `remedy run` catches one thing: an approval that appears during the run is removed, the run's items are blocked and it exits 5. `remedy approve` and `import-artifact --items` therefore wait until no run is active. A process that outlives the run is not caught, and neither is anything else that code does, so read the branch before merging it.

## Test ladder
| When | Run | Who |
|---|---|---|
| While working | The pinned test: the brief's `fixit test <file> --grep <name>` | Builder |
| Before committing | The affected lanes the plan names, plus types and lint where touched: `fixit test --changed` or the lane | Builder |
| Once per cluster | The full campaign, in the background | `remedy-tester`, started by the lead |

Run tests only with `fixit test` and read logs only with `fixit logs`, never raw `vitest`, `go test`, `make test-*` or `docker logs`. A lane that does not exist is added to `fixit.config.json`, not run around.

Never run a full lane while working on one item. Never re-run a command to see more of its output: use `fixit show <run>` or the path the guard printed. Report failures faithfully.

## Stop rules
- **Same failure twice:** `fixit test` prints STOP. Write the report with status `stuck` and return. The lead escalates to a fresh builder on Opus.
- **Turn limit:** keep the report current at each milestone (test red, fix in, test green, lane green), so nothing depends on a final turn.
- **Context guard:** when told to stop, write the report with status `handoff` and return.
- **Flaky:** a failure reported as flaky costs no further work unless it recurs.
- At most 2–3 chains at once.

## Report and order
`remedy report ID`, from stdin: status (done, stuck, handoff, plan-drift), branch, commit, pinned result with run id, what you tried, next step, open questions. The final reply is at most 10 lines. "Build in order" follows the cluster's build order, one worker per item or small group, stopping between items only for failures or decisions.
