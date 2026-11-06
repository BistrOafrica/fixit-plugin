---
description: Full discovery, security audit then test campaign, each in its own fresh session, merged at intake
argument-hint: "[audit profile quick|standard|deep] [load profile smoke|stress]"
model: sonnet
effort: medium
---
The two discovery engines no longer run in one session. They find different defects (source-level trust-boundary flaws, and behaviour under real use and load), and together they are the complete picture, but one session holding both grows too large.

1. `/fixit-plugin:init` steps if `.remedy/` is missing.
2. **Security audit, in this session.** Follow `/fixit-plugin:audit` with the profile from "$ARGUMENTS" (default standard): the skill at `${CLAUDE_PLUGIN_ROOT}/skills/security-audit/SKILL.md`, output outside the repo, both validators passing, hunters and verifiers as that command maps them. Import with `remedy import-findings <audit-out>/findings.json --prefix SEC`.
3. Run `remedy handoff`, then tell the owner to run `/fixit-plugin:test` in a fresh session (`claude --model sonnet`) with the load profile from "$ARGUMENTS" (default smoke). Do not run the campaign here.
4. After the campaign, the owner runs `/fixit-plugin:intake` to import `campaign/campaign-findings.json` and merge overlaps: fingerprints dedupe; where both engines found the same defect (same location and root cause), keep one item, add the other's evidence to `sources`, and note both `foundBy` layers.
Report for this session: confirmed by severity, leads needing validation, and the next step.
