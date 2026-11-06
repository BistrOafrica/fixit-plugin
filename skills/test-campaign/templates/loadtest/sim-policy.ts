/**
 * Simulated back office: one bot per reviewer account, acting ONLY through the
 * public API (never the DB). Decision policy is data (decision-policy.json) and
 * every draw is seeded so a run replays.
 *
 * ADAPT: inbox/claim/decide endpoints, how a stage is read, roles.
 */
import { hashSeed, rng, type Rng } from "../rng.ts";

type Weights = { approve?: number; reject?: number; request_info?: number; thinkTime?: Dist };
type Dist = { kind: "lognormal"; medianMs: number; p95Ms: number } | { kind: "uniform"; minMs: number; maxMs: number };
export interface Policy {
  seed: number; default: Required<Pick<Weights, "approve" | "reject" | "request_info">> & { thinkTime: Dist };
  byRole?: Record<string, Weights>; byProcess?: Record<string, { default?: Weights; byNode?: Record<string, Weights> }>;
  maxRequestInfoPerEntity: number; probeRate: number; pollInterval: Dist; allocation: "round_robin" | "random";
}
export interface Ctx { entityId: string; processSlug: string; nodeId: string; visit: number; role: string; requestInfoSoFar: number }

/** Resolution: byProcess.byNode > byProcess.default > byRole > default. */
export function resolve(p: Policy, c: Ctx) {
  const layers = [p.default, p.byRole?.[c.role], p.byProcess?.[c.processSlug]?.default, p.byProcess?.[c.processSlug]?.byNode?.[c.nodeId]];
  return Object.assign({}, ...layers.filter(Boolean)) as Policy["default"];
}

export function sample(d: Dist, r: Rng): number {
  if (d.kind === "uniform") return d.minMs + r.next() * (d.maxMs - d.minMs);
  const sigma = Math.log(d.p95Ms / d.medianMs) / 1.645; // lognormal from median + p95
  const z = Math.sqrt(-2 * Math.log(r.next() || 1e-9)) * Math.cos(2 * Math.PI * r.next());
  return d.medianMs * Math.exp(sigma * z);
}

export function decide(p: Policy, c: Ctx): { action: "approve" | "reject" | "request_info"; thinkMs: number; probe: boolean } {
  const w = resolve(p, c);
  const r = rng(hashSeed(p.seed, c.entityId, c.nodeId, c.visit));
  const ri = c.requestInfoSoFar >= p.maxRequestInfoPerEntity ? 0 : w.request_info;
  const total = w.approve + w.reject + ri;
  // With request_info capped and no other weight left, fall back to approve —
  // never let `|| 1` route the draw into the capped branch.
  const x = r.next() * total;
  const action = total <= 0 ? "approve" : x < w.approve ? "approve" : x < w.approve + w.reject ? "reject" : "request_info";
  return { action, thinkMs: sample(w.thinkTime, r), probe: r.chance(p.probeRate) };
}

/**
 * Bot loop (sketch):
 *   for (;;) {
 *     const items = GET /me/inbox                       // its own inbox via the API
 *     for (const it of items) {
 *       const claim = PATCH /items/:id/accept           // 403/404 → a peer won the race; move on
 *       const d = decide(policy, ctxOf(it)); await sleep(d.thinkMs);
 *       if (d.probe) { const r = POST a stage NOT addressed to me; if (r.ok) record probeViolation }
 *       POST /items/:id/decision { action: d.action }   // tasks: complete with an outcome / allocate round-robin
 *       append to decisions.ndjson
 *     }
 *     await sleep(sample(policy.pollInterval, rng(Date.now())));
 *   }
 * Supervisors only clear stages the seed marked unactionable — count every clearance (it is a finding).
 * Ledger: in-memory Map + append every mutation to ledger.ndjson; replay on start. Leases: nextCheckAt / leasedUntil.
 * Control plane: /metrics /summary /preflight /ledger /ledger/due /ledger/stats /ledger/:id/observe;
 * rewrite sim-summary.json every tick so a killed run still leaves a summary.
 */
