/**
 * Walk EVERY configured process along every path type. One describe per
 * process, one test per path. Unknown invariant violations fail; known ones are
 * reported as todo — and a known bug may only excuse the outcome it explains.
 *
 *   SIM_SERVICES=a,b  SIM_MAX_PATHS=3  node --test this.sim.test.ts
 *
 * ADAPT: listProcesses(), makeDeps(), KNOWN_BUGS keys (invariant names).
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { useInlineEngine } from "./engine-harness";
import { approveAll, outcomeAt, rejectAt, requestInfoAt, walk, type Strategy, type WalkResult } from "./workflow-walker";
import { listProcesses, makeDeps } from "./sim-setup"; // ADAPT

const KNOWN_BUGS: Record<string, string> = {
  // "allocation-honoured": "BUG WF-03: allocation before the first stage is dropped",
};
const only = process.env.SIM_SERVICES?.split(",");
const maxPaths = Number(process.env.SIM_MAX_PATHS || 99);
const engine = useInlineEngine();
const matrix: Record<string, Record<string, { status: string; final?: string; violations?: string[]; supervisor?: boolean }>> = {};

const processes = (await listProcesses()).filter((p) => !only || only.includes(p.slug));
for (const proc of processes) {
  describe(proc.slug, () => {
    let happy: WalkResult | undefined;
    const record = (path: string, r: WalkResult | null, status: string) =>
      ((matrix[proc.slug] ??= {})[path] = { status, final: r?.final, violations: r?.violations.map((v) => v.invariant), supervisor: !!r?.supervisorOverrides.length });

    const run = (path: string, strategy: () => Strategy | null) =>
      test(path, async (t) => {
        const s = strategy();
        if (!s) { record(path, null, "n/a"); return t.skip("path not in this workflow"); }
        const r = await walk(await makeDeps(proc, engine), s);
        if (path === "approve-all") happy = r;
        const known = r.violations.filter((v) => KNOWN_BUGS[v.invariant]);
        const unknown = r.violations.filter((v) => !KNOWN_BUGS[v.invariant]);
        record(path, r, unknown.length ? "fail" : known.length ? "bug" : "pass");
        assert.deepEqual(r.probeFailures, [], "the wrong people were refused at every stage");
        assert.deepEqual(unknown, [], "lifecycle invariants hold");
        if (known.length) t.todo([...new Set(known.map((v) => KNOWN_BUGS[v.invariant]))].join(" | "));
      });

    run("approve-all", () => approveAll);
    const stages = () => happy?.parkedAt.filter((p) => p.type === "approval") ?? [];
    const paths: Array<[string, () => Strategy | null]> = [
      ["reject-first", () => (stages()[0] ? rejectAt(stages()[0]!.nodeId) : null)],
      ["reject-last", () => (stages().length > 1 ? rejectAt(stages().at(-1)!.nodeId) : null)],
      ["request-info", () => (stages()[0] ? requestInfoAt(stages()[0]!.nodeId) : null)],
    ];
    for (const task of happy?.parkedAt.filter((p) => p.type === "task" && (p.outcomeOptions?.length ?? 0) > 1) ?? [])
      for (const o of task.outcomeOptions!.slice(1)) paths.push([`outcome ${task.nodeId}=${o}`, () => outcomeAt(task.nodeId, o)]);
    for (const [name, s] of paths.slice(0, maxPaths)) run(name, s);
  });
}

after(() => {
  mkdirSync("coverage", { recursive: true });
  writeFileSync("coverage/workflow-matrix.json", JSON.stringify(matrix, null, 2)); // CI renders this as a table
});
