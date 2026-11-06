---
description: Run the defect-discovery test campaign (not the test runner; that is the fixit test CLI) and pin what it finds
argument-hint: "[layers, e.g. 'http sim load e2e' | 'all'] [profile, e.g. smoke|stress]"
model: sonnet
effort: medium
---
Use a fresh session; start it with `claude --model sonnet`, because a command's `model` lasts one turn. This command finds defects. To run existing tests, use `fixit test`.

Load the `test-campaign` skill from `${CLAUDE_PLUGIN_ROOT}/skills/test-campaign/SKILL.md` and run it in **full campaign mode** with "$ARGUMENTS" (default: every layer RECON selects; load profile `smoke`).

1. Reconnaissance (RECON.md), in this session or via a `campaign-author`: write `campaign/plan.md`. Ask the owner one round only if scope or machine limits are unclear.
2. Spawn one `campaign-author` per layer, one at a time, each fresh (take model and effort from `remedy route --role campaign-author`). The prompt is the layer, the absolute path of its companion file, and the absolute path of `${CLAUDE_PLUGIN_ROOT}/skills/test-campaign/templates/`. Foundations (FOUNDATIONS.md) come first; never point a harness at a non-test database. Authors run tests only through `fixit test`, and register new lanes in `fixit.config.json`. Do not fix product code.
3. Merge `campaign/layers/*.json` into `campaign/campaign-findings.json` with a script (validate against `campaign-findings.schema.json`), and write `campaign/REPORT.md` (REPORTING.md).
4. If `.remedy/` exists (or the owner wants it), import: `remedy import-campaign campaign/campaign-findings.json`, propose clusters, `remedy validate`, `remedy render`.
Report: layers run (and not run, with why), defects by severity and by layer, pinned tests added, capacity verdict, and suggested first cluster. End with `remedy handoff`.
