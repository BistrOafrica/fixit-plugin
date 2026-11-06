/**
 * Lifecycle invariants — what must hold for every entity however it was driven.
 * Pure functions over plain data, shared by the deterministic simulations and
 * the load-test reconciler so "correct" means the same thing in both.
 * Each checker returns violations; [] means the invariant holds.
 *
 * ADAPT: statuses, terminal set, transitions (derive them from the code that
 * writes the status), integrity facts (money, issued documents).
 */

export interface Violation { invariant: string; entityId?: string; detail: string }

// ── status transitions ──────────────────────────────────────────────────────
export const TERMINAL_STATUSES = new Set(["approved", "rejected", "withdrawn"]);
export const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
  draft: ["submitted", "withdrawn"],
  submitted: ["under_review", "more_info_needed", "approved", "rejected", "withdrawn"],
  under_review: ["more_info_needed", "approved", "rejected", "withdrawn"],
  more_info_needed: ["under_review", "withdrawn", "rejected"],
  approved: [],
  rejected: [],
  withdrawn: [],
};

export function checkTransitions(entityId: string, statuses: readonly string[]): Violation[] {
  const out: Violation[] = [];
  for (let i = 1; i < statuses.length; i++) {
    const from = statuses[i - 1]!, to = statuses[i]!;
    if (from === to) continue;
    const allowed = ALLOWED_TRANSITIONS[from];
    if (!allowed) out.push({ invariant: "transitions", entityId, detail: `unknown status "${from}"` });
    else if (!allowed.includes(to)) out.push({ invariant: "transitions", entityId, detail: `illegal transition ${from} → ${to}` });
  }
  return out;
}

// ── moves follow the process graph (one advance may run several nodes) ──────
export interface GraphLike { nodes: Array<{ id: string }>; edges: Array<{ source: string; target: string }> }

export function reachable(g: GraphLike, from: string, to: string): boolean {
  if (from === to) return true;
  const out = new Map<string, string[]>();
  for (const e of g.edges) out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
  const seen = new Set([from]), queue = [from];
  while (queue.length) {
    for (const t of out.get(queue.shift()!) ?? []) {
      if (t === to) return true;
      if (!seen.has(t)) { seen.add(t); queue.push(t); }
    }
  }
  return false;
}

export function checkStageOrder(entityId: string, g: GraphLike, moves: ReadonlyArray<{ from: string | null; to: string | null }>): Violation[] {
  const ids = new Set(g.nodes.map((n) => n.id));
  const out: Violation[] = [];
  for (const m of moves) {
    if (m.to && !ids.has(m.to)) out.push({ invariant: "stage-order", entityId, detail: `moved to unknown node "${m.to}"` });
    else if (m.from && m.to && !reachable(g, m.from, m.to)) out.push({ invariant: "stage-order", entityId, detail: `jumped ${m.from} → ${m.to}` });
  }
  return out;
}

// ── only the addressed role, the allocated user, or a manager decides ───────
export interface StageDecision {
  nodeId: string; stageRoles: readonly string[]; allocatedUserId?: string | null;
  actorUserId: string; actorRoles: readonly string[]; actorCanManage: boolean; action: string;
}
export function checkAuthorizedDecisions(entityId: string, ds: readonly StageDecision[]): Violation[] {
  return ds
    .filter((d) => ["approve", "reject", "request_info"].includes(d.action))
    .filter((d) => !d.actorCanManage && (d.allocatedUserId ? d.allocatedUserId !== d.actorUserId : !d.stageRoles.some((r) => d.actorRoles.includes(r))))
    .map((d) => ({ invariant: "authorized-decisions", entityId, detail: `user ${d.actorUserId} (${d.actorRoles.join(",") || "no roles"}) did "${d.action}" on ${d.nodeId} addressed to ${d.stageRoles.join(",")}` }));
}

// ── decisions are final: nothing after a terminal decision on the same stage ─
export function checkSingleDecision(entityId: string, ds: ReadonlyArray<{ nodeId: string; visit: number; action: string }>): Violation[] {
  const seen = new Map<string, number>();
  for (const d of ds) if (["approve", "reject"].includes(d.action)) seen.set(`${d.nodeId}#${d.visit}`, (seen.get(`${d.nodeId}#${d.visit}`) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([k, n]) => ({ invariant: "single-decision", entityId, detail: `${k} decided ${n} times` }));
}

// ── money and issued documents ─────────────────────────────────────────────────────
export interface IntegrityFacts {
  entityId: string; finalStatus: string;
  chargesByNode: Record<string, number>; paymentConsumptions: Record<string, number>; issuedDocuments: number;
}
export function checkIntegrity(f: IntegrityFacts): Violation[] {
  const out: Violation[] = [];
  for (const [node, n] of Object.entries(f.chargesByNode)) if (n > 1) out.push({ invariant: "integrity", entityId: f.entityId, detail: `${n} charges for payment node ${node}` });
  for (const [ref, n] of Object.entries(f.paymentConsumptions)) if (n > 1) out.push({ invariant: "integrity", entityId: f.entityId, detail: `payment ${ref} spent ${n} times` });
  if (f.issuedDocuments > 1) out.push({ invariant: "integrity", entityId: f.entityId, detail: `${f.issuedDocuments} documents issued` });
  if (f.finalStatus !== "approved" && f.issuedDocuments > 0) out.push({ invariant: "integrity", entityId: f.entityId, detail: `document issued for a ${f.finalStatus} entity` });
  return out;
}

// ── submitter data frozen after submit; append-only logs never shrink ───────
export const SUBMITTER_EDITABLE = new Set(["draft", "more_info_needed"]);
export function checkNoEditAfterSubmit(entityId: string, changes: ReadonlyArray<{ oldStatus: string; formChanged: boolean }>): Violation[] {
  return changes.filter((c) => c.formChanged && !SUBMITTER_EDITABLE.has(c.oldStatus))
    .map((c) => ({ invariant: "edit-after-submit", entityId, detail: `answers rewritten while "${c.oldStatus}"` }));
}
export function checkAppendOnly(entityId: string, before: Record<string, number>, after: Record<string, number>): Violation[] {
  return Object.keys(before).filter((k) => (after[k] ?? 0) < before[k]!)
    .map((k) => ({ invariant: "lost-update", entityId, detail: `${k} shrank ${before[k]} → ${after[k]}` }));
}

/** invariant → count + samples, for reports. */
export function summarize(vs: readonly Violation[], samples = 5) {
  const out: Record<string, { count: number; samples: string[] }> = {};
  for (const v of vs) {
    const s = (out[v.invariant] ??= { count: 0, samples: [] });
    s.count++;
    if (s.samples.length < samples) s.samples.push(`${v.entityId ?? "-"}: ${v.detail}`);
  }
  return out;
}
