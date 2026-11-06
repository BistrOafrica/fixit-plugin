---
description: Set up a gated remediation programme (register + tracker) in this repository
argument-hint: "[programme title]"
model: haiku
effort: low
---
Load the `remedy` skill (read its SKILL.md and BACKENDS.md from `${CLAUDE_PLUGIN_ROOT}/skills/remedy/`; read PROTOCOL.md only if the owner asks about the data model).

Set up a remediation programme for this repository:
1. If `.remedy/` already exists, run `remedy status` and report instead of re-initialising.
2. Otherwise run `remedy init --title "$ARGUMENTS"` (derive a title from the repo name if none was given; plans go in `docs/remediation/` unless the repo has a better place).
3. Run `remedy init --settings`. It prints the project settings a token-efficient run needs and writes nothing. Show the diff to the owner, ask, and only then run `remedy init --settings --apply`. `--revert` undoes it.
4. Ask the owner, in one round, only what you can't infer: what is out of scope (recorded in `meta.excluded`), whether they also want a live claude.ai tracker page (BACKENDS.md §B), and which intake sources to run first (security audit, test markers, TODO sweep, an existing bug list).
5. Explain two directories. `.fixit/` holds disposable test runs and logs and ignores itself. `fixit.config.json` at the repo root, which you commit, names the test lanes and log sources that `fixit test` and `fixit logs` use. A test lane that is not in it cannot be run through `fixit`, so add it to the config rather than running the command raw. Offer to draft it from the repo's test scripts.
6. Render the dashboard (`remedy render`) and tell the owner where it is and what the next command is (`/fixit-plugin:intake` or `/fixit-plugin:audit`).
