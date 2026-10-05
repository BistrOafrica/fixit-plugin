---
description: Run the bundled security audit, then import its verified findings into the register and tracker
argument-hint: "[scope or profile, e.g. 'quick', 'deep', or a path]"
---
1. Load the `security-audit` skill from `${CLAUDE_PLUGIN_ROOT}/skills/security-audit/SKILL.md` and run it in **full audit mode** against this repository with the scope/profile "$ARGUMENTS" (default `standard`). Follow all of its rules, including the external output directory, sandboxed execution only, and both validators passing before Phase 6 is complete.
2. Load the `remedy` skill. If `.remedy/` is missing, initialise it (`/fixit-plugin:init` steps).
3. Import the run: `node ${CLAUDE_PLUGIN_ROOT}/skills/remedy/scripts/remedy.cjs import-findings <output-dir>/findings.json --prefix SEC`.
4. Propose clusters for the new items (INTAKE.md, Clustering), create them, run `remedy validate` and `remedy render`.
5. Report: confirmed findings by severity, needs-validation leads, clusters proposed, and the first cluster to plan. Do not start planning until the owner says so.
