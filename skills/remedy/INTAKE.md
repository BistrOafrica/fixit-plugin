# Intake — filling the register and the tracker

Every source ends in the same place: a register row for each **confirmed defect** and a tracker item for **every unit of work**. Dedupe before adding (`fingerprint`, `registerKey`, or a title/location match), and use `next-id` for new ids.

## 1. Security audit (bundled `security-audit` skill)

1. Run the audit in **full audit mode** with the `security-audit` skill. Keep its rules: output directory outside the repo (default `~/security-audit-skill/<repo>/run-<N>`), sandboxed execution only, both validators passing before you continue.
2. Import the verified records:
   ```
   node <remedy>/scripts/remedy.cjs import-findings ~/security-audit-skill/<repo>/run-<N>/findings.json --prefix SEC
   ```
   - `confirmed` → a register row **and** a tracker item. Severity is the audit's `overall_severity`; wave W0 for critical, W1 for high, W3 otherwise; the audit's remediation strategy goes into the item note as a starting hypothesis (the plan still has to verify it).
   - `needs_validation` → a tracker item, kind `validation`, severity `unrated`, its blockers in `sources`. Planning it means resolving the blocker: confirm (add a register row with `add-row` and set `registerKey`) or reject (`stage wont_do` with the reason).
   - `rejected` → not imported (counted only).
   - Re-running is additive: fingerprints already on the ledger are reported as `carried` and not duplicated.
3. Group the new items into clusters (below) and tell the owner what landed.

## 1b. Test campaign (bundled `test-campaign` skill)

Run the campaign (its SKILL.md), which writes `campaign/campaign-findings.json` with every defect already pinned by a test. Import:
```
node <remedy>/scripts/remedy.cjs import-campaign campaign/campaign-findings.json
```
- `confirmed` → register row + tracker item; the id prefix follows the layer (http-authz → SEC, simulation/load → WF, capacity → PERF, browser/front-end → WEB, static → TOOL; override with `--prefix`), `foundBy` names the layer, `pinnedBy` is kept so the build flips that test.
- `lead` → tracker item, kind `validation`, severity `unrated`.
- Fingerprints dedupe across runs and across engines; when the audit and the campaign found the same defect, keep one item and merge the evidence.

## 2. Existing test suites and pinned defects

When a test suite encodes known bugs (`it.fails`, `test.todo`, `test.fixme`, `xfail`, `KNOWN_*` ratchet lists, `// BUG:` comments):
```
node <remedy>/scripts/remedy.cjs scan > /tmp/markers.json
```
Triage each marker: confirm the defect by reading the code, then add a register row (`foundBy`: the test layer) and a tracker item with `pinnedBy` set to the exact test (`path · test name (it.fails)`). The build flips that marker.

## 3. Code and plan sweep (TODOs, stubs, gaps)

Search for TODO/FIXME/"not yet available"/"coming soon"/placeholder returns, dead routes, mock-only screens, and unchecked items in design/plan docs. These become tracker items **without** register rows (kinds todo/stub/gap/debt/feature), unless they cause wrong behaviour today — then they are defects and get a row. Use an exploration subagent for broad sweeps and keep only conclusions.

## 4. Owner reports

A user-reported symptom ("the map is a blank white canvas") is reproduced first, then filed: register row (`foundBy: Owner report (<date>)`), tracker item, and — if asked — a plan in the same run.

## 5. Side finds during planning or building

Anything found while planning or building another item is filed immediately (`foundBy: Code review (remediation planning)`), in the current cluster if it belongs there, otherwise as **standalone backlog**. Mention it in the run's report. Never fix it silently inside an unrelated change.

## Clustering

After intake, propose clusters: items that touch the same code or need the same design decision. Create them with:
```
node <remedy>/scripts/remedy.cjs cluster AUTH --name "Account takeover in sign-in" --items SEC-01,SEC-02,SEC-03
```
Order clusters by wave, then by dependency. Keep `excluded` in meta current when the owner rules something out of scope.
