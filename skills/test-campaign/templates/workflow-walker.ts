/**
 * Walk one configured process end to end over the public API, deciding each
 * human stage by a STRATEGY, probing at every stage that the wrong people are
 * refused, and checking invariants afterwards.
 *
 * ADAPT: fileApplication (exactly as the real client files), the inbox/decision
 * endpoints, how a parked stage is read, status names, the role → user pool.
 */
import { as } from "./http-client";
import type { InlineEngine } from "./engine-harness";
import { checkAuthorizedDecisions, checkStageOrder, checkTransitions, TERMINAL_STATUSES, type StageDecision, type Violation } from "./invariants";

export interface Parked { nodeId: string; type: "approval" | "task"; visit: number; roles: string[]; outcomeOptions?: string[] }
export type Decision = { action: "approve" | "reject" | "request_info" } | { action: "complete"; outcome?: string };
export type Strategy = (p: Parked) => Decision;

export const approveAll: Strategy = (p) => (p.type === "task" ? { action: "complete", outcome: p.outcomeOptions?.[0] } : { action: "approve" });
export const rejectAt = (node: string): Strategy => (p) => (p.nodeId === node && p.type === "approval" ? { action: "reject" } : approveAll(p));
export const requestInfoAt = (node: string): Strategy => (p) => (p.nodeId === node && p.visit === 1 && p.type === "approval" ? { action: "request_info" } : approveAll(p));
export const outcomeAt = (node: string, value: string): Strategy => (p) => (p.nodeId === node ? { action: "complete", outcome: value } : approveAll(p));

export interface WalkResult {
  final: string; stuck: boolean; steps: number; parkedAt: Parked[];
  supervisorOverrides: Array<{ nodeId: string; roles: string[]; reason: string }>;
  probeFailures: string[]; violations: Violation[];
}

export interface WalkDeps {
  engine: InlineEngine;
  pool: { forRole(role: string): Promise<any | null>; supervisor(): Promise<any>; outsider(excluding: string[]): Promise<any> };
  applicant: any;
  fileApplication(applicant: any): Promise<string>;                        // ADAPT: returns entity id
  readState(id: string): Promise<{ status: string; parked: Parked | null; atPayment: boolean; graph: any }>; // ADAPT
  pay(applicant: any, id: string): Promise<void>;                          // ADAPT
  answerChangeRequest(applicant: any, id: string): Promise<void>;          // ADAPT: re-answer requested fields, resubmit
  decisionPath(id: string, p: Parked): string;                             // ADAPT: e.g. `/approvals/${id}/stages/${p.nodeId}`
}

export async function walk(d: WalkDeps, strategy: Strategy, maxSteps = 40): Promise<WalkResult> {
  const r: WalkResult = { final: "", stuck: false, steps: 0, parkedAt: [], supervisorOverrides: [], probeFailures: [], violations: [] };
  const statuses: string[] = [], decisions: StageDecision[] = [];
  const id = await d.fileApplication(d.applicant);
  for (; r.steps < maxSteps; r.steps++) {
    await d.engine.drain();
    const s = await d.readState(id);
    statuses.push(s.status);
    if (TERMINAL_STATUSES.has(s.status)) break;
    if (s.status === "more_info_needed") { await d.answerChangeRequest(d.applicant, id); continue; }
    if (s.atPayment) { await d.pay(d.applicant, id); continue; }
    if (!s.parked) {
      if ((await d.engine.advanceTime(8 * 86_400_000)) === 0) { r.stuck = true; break; }
      continue;
    }
    const p = s.parked;
    r.parkedAt.push(p);
    const path = d.decisionPath(id, p);
    const body = strategy(p);

    // Negative probes — each must be refused.
    const outsider = await d.pool.outsider(p.roles);
    for (const [who, res] of [
      ["outsider", await as(outsider).post(`${path}/decision`, body)],
      ["applicant", await as(d.applicant).post(`${path}/decision`, body)],
    ] as const) if (![401, 403, 404].includes(res.status)) r.probeFailures.push(`${who} got ${res.status} on ${p.nodeId}`);

    let actor = await d.pool.forRole(p.roles[0]!);
    let res = actor ? await as(actor).post(`${path}/decision`, body) : { status: 0 };
    let canManage = false;
    if (!actor || res.status === 403) {
      r.supervisorOverrides.push({ nodeId: p.nodeId, roles: p.roles, reason: actor ? "role refused" : "no user can hold the role" });
      actor = await d.pool.supervisor(); canManage = true;
      res = await as(actor).post(`${path}/decision`, body);
    }
    if (res.status >= 300) throw new Error(`decision on ${p.nodeId} failed: ${res.status}`);
    decisions.push({ nodeId: p.nodeId, stageRoles: p.roles, actorUserId: actor.id, actorRoles: actor.roles, actorCanManage: canManage, action: body.action });
  }
  const final = await d.readState(id);
  r.final = final.status;
  r.violations.push(
    ...checkTransitions(id, statuses),
    ...checkStageOrder(id, final.graph, d.engine.trace.map((t) => ({ from: t.fromNode, to: t.toNode }))),
    ...checkAuthorizedDecisions(id, decisions),
  );
  if (!TERMINAL_STATUSES.has(r.final) && !r.stuck) r.violations.push({ invariant: "terminal", entityId: id, detail: `ended "${r.final}" after ${r.steps} steps` });
  return r;
}
