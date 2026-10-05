---
description: Full discovery — security audit AND test campaign, both imported into one register and tracker
argument-hint: "[audit profile quick|standard|deep] [load profile smoke|stress]"
---
Run both discovery engines, then one intake. They find different defects (source-level trust-boundary flaws vs behaviour under real use and load); together they are the complete picture.

1. `/fixit-plugin:init` steps if `.remedy/` is missing.
2. **Security audit** — load `${CLAUDE_PLUGIN_ROOT}/skills/security-audit/SKILL.md`, full audit mode (profile from "$ARGUMENTS", default standard), output outside the repo; both validators must pass.
3. **Test campaign** — load `${CLAUDE_PLUGIN_ROOT}/skills/test-campaign/SKILL.md`, full campaign mode (load profile from "$ARGUMENTS", default smoke).
4. **Intake** — `remedy import-findings <audit-out>/findings.json --prefix SEC` and `remedy import-campaign campaign/campaign-findings.json`. Fingerprints dedupe; where both engines found the same defect (same location and root cause), keep one item, add the other's evidence to `sources`, and note both `foundBy` layers.
5. Propose clusters across both sets (INTAKE.md · Clustering), `remedy validate`, `remedy render`.
Report: confirmed by severity and by engine, overlaps, leads needing validation, the capacity verdict, and the recommended first clusters. Do not start planning until the owner says so.
