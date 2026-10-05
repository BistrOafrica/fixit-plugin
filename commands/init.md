---
description: Set up a gated remediation programme (register + tracker) in this repository
argument-hint: "[programme title]"
---
Load the `remedy` skill (read its SKILL.md, PROTOCOL.md and BACKENDS.md from `${CLAUDE_PLUGIN_ROOT}/skills/remedy/`).

Set up a remediation programme for this repository:
1. If `.remedy/` already exists, run `node ${CLAUDE_PLUGIN_ROOT}/skills/remedy/scripts/remedy.cjs status` and report instead of re-initialising.
2. Otherwise run `node ${CLAUDE_PLUGIN_ROOT}/skills/remedy/scripts/remedy.cjs init --title "$ARGUMENTS"` (derive a title from the repo name if none was given; plans go in `docs/remediation/` unless the repo has a better place).
3. Ask the owner, in one round, only what you can't infer: what is out of scope (recorded in `meta.excluded`), whether they also want a live claude.ai tracker page (BACKENDS.md §B), and which intake sources to run first (security audit, test markers, TODO sweep, an existing bug list).
4. Render the dashboard (`remedy render`) and tell the owner where it is and what the next command is (`/fixit-plugin:intake` or `/fixit-plugin:audit`).
