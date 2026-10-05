// node --test skills/test-campaign/templates/templates.unit.test.ts   (Node ≥ 23 strips types natively)
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashSeed, rng } from "./rng.ts";
import { checkAuthorizedDecisions, checkIntegrity, checkSingleDecision, checkStageOrder, checkTransitions, reachable, summarize } from "./invariants.ts";
import { assertMatchesKnown, partitionKnown } from "./ratchet.ts";
import { decide, resolve, type Policy } from "./loadtest/sim-policy.ts";

test("rng is deterministic per seed and hashSeed is stable", () => {
  const a = rng(hashSeed("run", 1, "svc")), b = rng(hashSeed("run", 1, "svc"));
  assert.deepEqual([a.next(), a.next(), a.int(1, 6)], [b.next(), b.next(), b.int(1, 6)]);
  assert.notEqual(hashSeed("run", 1), hashSeed("run", 2));
});

test("transitions: leaving a terminal status is a violation", () => {
  assert.deepEqual(checkTransitions("e1", ["draft", "submitted", "under_review", "approved"]), []);
  assert.equal(checkTransitions("e1", ["approved", "under_review"])[0]?.invariant, "transitions");
});

test("stage order follows graph edges (multi-hop allowed)", () => {
  const g = { nodes: [{ id: "a" }, { id: "b" }, { id: "c" }], edges: [{ source: "a", target: "b" }, { source: "b", target: "c" }] };
  assert.ok(reachable(g, "a", "c"));
  assert.deepEqual(checkStageOrder("e1", g, [{ from: "a", to: "c" }]), []);
  assert.equal(checkStageOrder("e1", g, [{ from: "c", to: "a" }]).length, 1);
});

test("decisions: wrong role and double decisions are caught", () => {
  const base = { nodeId: "n", stageRoles: ["registrar"], actorUserId: "u", actorCanManage: false, action: "approve" };
  assert.deepEqual(checkAuthorizedDecisions("e", [{ ...base, actorRoles: ["registrar"] }]), []);
  assert.equal(checkAuthorizedDecisions("e", [{ ...base, actorRoles: ["clerk"] }]).length, 1);
  assert.equal(checkSingleDecision("e", [{ nodeId: "n", visit: 1, action: "approve" }, { nodeId: "n", visit: 1, action: "reject" }]).length, 1);
});

test("integrity: double spend and certificate without approval", () => {
  const v = checkIntegrity({ entityId: "e", finalStatus: "rejected", invoicesByNode: { pay: 2 }, paymentConsumptions: { p1: 2 }, certificates: 1 });
  assert.equal(v.length, 3);
  assert.equal(summarize(v).integrity?.count, 3);
});

test("ratchet: new and fixed entries both fail; partitionKnown matches invariant + detail", () => {
  assert.doesNotThrow(() => assertMatchesKnown(new Set(["x"]), new Set(["x"]), "items"));
  assert.throws(() => assertMatchesKnown(new Set(["x", "y"]), new Set(["x"]), "items"), /new items/);
  assert.throws(() => assertMatchesKnown(new Set([]), new Set(["x"]), "items"), /fixed items/);
  const { known, unknown } = partitionKnown(
    [{ invariant: "integrity", detail: "payment p1 spent 2 times" }, { invariant: "integrity", detail: "2 certificates issued" }],
    [{ invariant: "integrity", match: "spent", issue: "PAY-01" }],
  );
  assert.equal(known.length, 1);
  assert.equal(unknown.length, 1);
});

test("decision policy: layered resolution, replayable draws, request_info capped", () => {
  const p: Policy = {
    seed: 1, default: { approve: 1, reject: 0, request_info: 0, thinkTime: { kind: "uniform", minMs: 10, maxMs: 20 } },
    byRole: { director: { reject: 1, approve: 0 } }, byProcess: { "svc-1": { byNode: { n2: { request_info: 5, approve: 0, reject: 0 } } } },
    maxRequestInfoPerEntity: 1, probeRate: 0, pollInterval: { kind: "uniform", minMs: 1, maxMs: 2 }, allocation: "round_robin",
  };
  const ctx = { entityId: "e", processSlug: "svc-1", nodeId: "n1", visit: 1, role: "director", requestInfoSoFar: 0 };
  assert.equal(resolve(p, ctx).reject, 1);
  assert.deepEqual(decide(p, ctx), decide(p, ctx));
  assert.equal(decide(p, { ...ctx, nodeId: "n2" }).action, "request_info");
  assert.notEqual(decide(p, { ...ctx, nodeId: "n2", requestInfoSoFar: 1 }).action, "request_info");
});
