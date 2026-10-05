/**
 * The two-assertion ratchet for known-defect lists.
 *
 *   const KNOWN_UNACTIONABLE = new Set(["aud-003/plan:auditor"]);   // keys: stable strings
 *   assertMatchesKnown(findUnactionable(catalog), KNOWN_UNACTIONABLE, "unactionable stages");
 *
 * A NEW defect turns the test red. A FIXED defect also turns it red until its
 * entry is deleted — so the list tracks reality and can only shrink.
 */
import assert from "node:assert/strict";

export function assertMatchesKnown(found: Set<string>, known: Set<string>, what: string): void {
  const added = [...found].filter((k) => !known.has(k)).sort();
  const fixed = [...known].filter((k) => !found.has(k)).sort();
  if (added.length) console.error(`new ${what}:\n  ${added.join("\n  ")}`);
  if (fixed.length) console.error(`fixed ${what} (delete from the known list):\n  ${fixed.join("\n  ")}`);
  assert.deepEqual(added, [], `new ${what}: ${added.join(", ")}`);
  assert.deepEqual(fixed, [], `fixed ${what} — delete from the known list: ${fixed.join(", ")}`);
}

/**
 * Map-shaped variant: key → reason/bug id. Use two tests:
 *   test("no unexpected X", () => assertNoUnexpected(found, KNOWN))
 *   test("every exemption is still real", () => assertStillReal(found, KNOWN))
 * "An allow-list that rots silently is worse than no allow-list."
 */
export function assertNoUnexpected(found: Set<string>, known: Map<string, string>, what = "items"): void {
  const added = [...found].filter((k) => !known.has(k)).sort();
  assert.deepEqual(added, [], `unexpected ${what}: ${added.join(", ")}`);
}
export function assertStillReal(found: Set<string>, known: Map<string, string>, what = "exemptions"): void {
  const stale = [...known.keys()].filter((k) => !found.has(k)).sort();
  assert.deepEqual(stale, [], `stale ${what} — fixed, delete them: ${stale.map((k) => `${k} (${known.get(k)})`).join(", ")}`);
}

/**
 * Partition violations into known and unknown. A known bug may only excuse the
 * outcome it explains: match on the invariant AND a detail substring.
 */
export interface KnownIssue { invariant: string; match?: string; issue: string }
export function partitionKnown<V extends { invariant: string; detail: string }>(vs: V[], known: KnownIssue[]) {
  const isKnown = (v: V) => known.find((k) => k.invariant === v.invariant && (!k.match || v.detail.includes(k.match)));
  return {
    known: vs.filter((v) => isKnown(v)).map((v) => ({ ...v, issue: isKnown(v)!.issue })),
    unknown: vs.filter((v) => !isKnown(v)),
  };
}
