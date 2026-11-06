---
description: Run the bundled security audit, then import its verified findings into the register and tracker
argument-hint: "[scope or profile, e.g. 'quick', 'deep', or a path]"
model: sonnet
effort: medium
---
Use a fresh session; start it with `claude --model sonnet`, because a command's `model` lasts one turn.

1. Load the `security-audit` skill from `${CLAUDE_PLUGIN_ROOT}/skills/security-audit/SKILL.md` and run it in **full audit mode** against this repository with the scope/profile "$ARGUMENTS" (default `standard`). Follow all of its rules, including the external output directory, sandboxed execution only, and both validators passing before Phase 6 is complete. On a large target, ask the owner for the skill's `budget` in agent invocations.
2. Agents. Recon and critics (the skill's `research` role) and hunters (`general`) go to `fixit-plugin:audit-hunter`; candidate verifiers (`general`) and record verifiers (`research`) go to `fixit-plugin:audit-verifier`. Take the model and effort from `remedy route --role audit-hunter`, `audit-hunter-deep` (profile `deep`: pass `model: opus` for hunters) or `audit-verifier`, and pass them in each Agent call. Put the skill's assignment contract in the prompt, as the agent bodies expect.
3. Load the `remedy` skill. If `.remedy/` is missing, initialise it (`/fixit-plugin:init` steps).
4. Import the run: `remedy import-findings <output-dir>/findings.json --prefix SEC`.
5. Propose clusters for the new items (INTAKE.md, Clustering) in one `remedy batch` file, then `remedy validate` and `remedy render`.
6. Report: confirmed findings by severity, needs-validation leads, clusters proposed, and the first cluster to plan. Do not start planning until the owner says so. End with `remedy handoff` and tell the owner to start the next step in a fresh session.
