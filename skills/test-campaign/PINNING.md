# Pinning known defects (the ratchet)

A campaign finds bugs but doesn't fix them. Each confirmed defect is pinned by a test that **asserts the correct behaviour**, reports the defect without failing CI, and **turns red when someone fixes the bug** until the marker is removed. The known-bug list can only shrink.

## Markers by framework

| Framework | Marker | Self-ratchet? |
|---|---|---|
| node:test | `test(name, { todo: "BUG: path:line — what" }, fn)` | no; the fix PR removes it by convention |
| Vitest / Jest | `it.fails("…", fn)` | **yes**: passes while the bug exists, fails once fixed |
| Vitest / Jest | `it.todo("BUG: …")` | no |
| Playwright | `test.fixme(...)` with a `// BUG: path:line — …` comment | no |
| pytest | `@pytest.mark.xfail(strict=True, reason="BUG: …")` | **yes** with `strict=True` |
| Lists in integrity or sweep tests | a `KNOWN_*` set or map with the two-assertion ratchet | **yes** |
| Load and reconciler invariants | `known-issues.json` `{invariant, match, issue}` | no; deleted by hand when fixed |

## The two-assertion ratchet ([templates/ratchet.ts](templates/ratchet.ts))
```ts
export function assertMatchesKnown(found: Set<string>, known: Set<string>, what: string) {
  const added = [...found].filter((k) => !known.has(k)).sort();
  const fixed = [...known].filter((k) => !found.has(k)).sort();
  assert.deepEqual(added, [], `new ${what}: ${added.join(", ")}`);
  assert.deepEqual(fixed, [], `fixed ${what} — delete from the known list: ${fixed.join(", ")}`);
}
```
- Keys are stable strings (`form/field`, `node:role`, `METHOD /path`).
- When a list is a map, the value is the reason or the bug id.
- Add a second test, "every exemption is still real": an allow-list that rots silently is worse than no allow-list.

## Rules
- **The marker names the defect and its location**: `BUG: src/auth.ts:195 — OTP accepts any code`, and the remedy id once one exists (`(SEC-03)`).
- **A known bug excuses only the outcome it explains.** In simulations and the reconciler, partition violations by invariant or match and fail on the unknown ones. Don't widen an exemption to make a run pass.
- **The fix flips the marker in the same change** (remedy BUILD.md). The pin becomes the regression test.
- Each pinned defect goes into `campaign-findings.json` with its `pinnedBy`, so the register can show "Pinned by".
