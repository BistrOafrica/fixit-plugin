# <ID>: <Title — the symptom in plain words>

Severity **<critical|high|medium|low>** · Wave <W> · Cluster <CLUSTER> · Overview: [<CLUSTER>.md](<CLUSTER>.md) · Depends on <IDs or —>
Planned <YYYY-MM-DD> · Status: plan review

## Root cause
<What happens, traced through the code with `path/file.ts:line` references. Name every consumer affected. Say what you reproduced and how, and what you ruled out.>

## Decision (owner, <YYYY-MM-DD>)
<The owner's answer, in their terms. Omit the section if no decision was needed.>

## Fix
<Numbered, concrete changes: files, functions, data shapes, migrations, flags, defaults. Name the invariant being enforced and where (the last trusted decision point). Include migration of existing data when behaviour changes.>

**Out of scope, noted:** <observations that are not part of this item — or delete>

## Files
<Every file the build will touch, repo-relative.>

## Tests
- <The test that **fails before** the fix and passes after — exact path and name.>
- <Edge and regression tests.>
- <How CI keeps it fixed (gate, guard, lint rule).>

**pinnedBy**: `<path> (<test name / marker>)`

## Acceptance
<One or two sentences an owner can check: observable behaviour when this is done.>
