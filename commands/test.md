---
description: Run a defect-discovery test campaign (HTTP authz, workflow simulation, k6 load lifecycle, capacity, Playwright, contracts, static sweeps) and pin what it finds
argument-hint: "[layers, e.g. 'http sim load e2e' | 'all'] [profile, e.g. smoke|stress]"
---
Load the `test-campaign` skill from `${CLAUDE_PLUGIN_ROOT}/skills/test-campaign/SKILL.md` and run it in **full campaign mode** with "$ARGUMENTS" (default: every layer RECON selects; load profile `smoke`).

1. Reconnaissance (RECON.md) → write `campaign/plan.md`; ask the owner one round only if scope or machine limits are unclear.
2. Foundations (FOUNDATIONS.md) — adapt the templates in `${CLAUDE_PLUGIN_ROOT}/skills/test-campaign/templates/` into the project; never point a harness at a non-test database.
3. Run each selected layer, pinning every defect as you go (PINNING.md). Do not fix product code.
4. Write `campaign/campaign-findings.json` (validate against `campaign-findings.schema.json`) and `campaign/REPORT.md` (REPORTING.md).
5. If `.remedy/` exists (or the owner wants it), import: `node ${CLAUDE_PLUGIN_ROOT}/skills/remedy/scripts/remedy.cjs import-campaign campaign/campaign-findings.json`, propose clusters, `remedy validate`, `remedy render`.
Report: layers run (and not run, with why), defects by severity and by layer, pinned tests added, capacity verdict, and suggested first cluster.
