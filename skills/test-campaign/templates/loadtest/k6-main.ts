/**
 * k6 actors for the load lifecycle. k6 plays the people who FILE work; the
 * simulator (sim-policy.ts) plays the people who DECIDE it; the reconciler
 * proves every item ended correctly.
 *
 *   k6 run -e PROFILE=smoke -e BASE_URL=… -e SIM_URL=… -e RUN_ID=… k6-main.ts
 *
 * ADAPT: the journey (login → browse → form → generate answers with the SHARED
 * generator → upload → pay → submit), endpoint paths, fixtures.
 */
import { check, sleep } from "k6";
import http from "k6/http";
import exec from "k6/execution";
import { SharedArray } from "k6/data";
import { Counter, Rate, Trend } from "k6/metrics";
import { hashSeed, rng } from "../rng.ts";
// import { generateFormData } from "../../src/testing/formgen.ts";   // ADAPT: the same generator the simulations use

const PROFILE = __ENV.PROFILE || "smoke";
const RUN_ID = __ENV.RUN_ID || "local";
const BASE = __ENV.BASE_URL || "http://localhost:28000/api/v1";
const SIM = __ENV.SIM_URL || "http://localhost:28090";
const profile = JSON.parse(open(`./profiles/${PROFILE}.json`));
const actors = new SharedArray("actors", () => JSON.parse(open(`${__ENV.FIXTURES_DIR || "../out/fixtures"}/applicants.json`)));
const PROCESS_COUNT = Number(__ENV.PROCESS_COUNT || 40); // from the simulator's /preflight

const created = new Counter("lt_created");
const probeFailed = new Rate("lt_probe_failed");
const unexpected = new Rate("lt_unexpected_status");
const timeToCreate = new Trend("lt_time_to_create_ms", true);

function actorsScenario() {
  const a = profile.actors;
  if (a.executor === "per-process") return { executor: "shared-iterations", vus: a.vus ?? 2, iterations: (a.perProcess ?? 1) * PROCESS_COUNT, maxDuration: a.maxDuration ?? "10m", exec: "file" };
  const { perProcess: _p, ...rest } = a;
  return { ...rest, exec: "file" };
}

export const options = {
  scenarios: {
    actors: actorsScenario(),
    followups: { executor: "constant-arrival-rate", ...profile.followups, exec: "followup" },
    browsers: { executor: "constant-vus", ...profile.browsers, exec: "browse" },
  },
  thresholds: profile.thresholds,
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

const tokens: Record<string, string> = {};
function auth(actor: any): Record<string, string> {
  if (!tokens[actor.email]) {
    const r = http.post(`${BASE}/auth/login`, JSON.stringify({ email: actor.email, password: actor.password }), { headers: { "Content-Type": "application/json" }, tags: { name: "POST /auth/login", lt: "app" } });
    tokens[actor.email] = r.json("access_token") as string;
  }
  return { Authorization: `Bearer ${tokens[actor.email]}`, "Content-Type": "application/json" };
}
function req(method: string, path: string, actor: any, body: unknown, name: string) {
  const r = http.request(method, `${BASE}${path}`, body === undefined ? null : JSON.stringify(body), { headers: auth(actor), tags: { name, lt: "app" } });
  if (r.status === 401) delete tokens[actor.email]; // long runs outlive the access token
  unexpected.add(r.status >= 500 || r.status === 0);
  return r;
}

export function file() {
  const it = exec.scenario.iterationInTest;
  const actor = actors[it % actors.length];
  const r = rng(hashSeed(RUN_ID, exec.vu.idInTest, it));
  const t0 = Date.now();
  // ADAPT: pick a process (round-robin over /preflight for per-process), fetch its form, generate answers, upload, pay, submit.
  const res = req("POST", "/submissions", actor, { processId: "ADAPT", answers: {} }, "POST /submissions");
  if (check(res, { "submitted": (x) => x.status === 201 })) {
    created.add(1);
    timeToCreate.add(Date.now() - t0);
    const id = res.json("data.id") as string;
    http.post(`${SIM}/ledger`, JSON.stringify({ id, actor: actor.email }), { headers: { "Content-Type": "application/json" }, tags: { name: "sim ledger" } });
    if (r.chance(profile.probeRate)) {
      const probe = req("PUT", `/submissions/${id}/answers`, actor, { answers: { tampered: true } }, "PUT /submissions/{id}/answers (probe)");
      probeFailed.add(![403, 409, 422].includes(probe.status)); // editing after submit must be refused
    }
  }
  sleep(r.next());
}

export function followup() {
  // Lease a due ledger entry; act as its applicant: answer change requests, pay invoices, report what was seen.
  const lease = http.get(`${SIM}/ledger/due`, { tags: { name: "sim due" } });
  if (lease.status !== 200 || !lease.body) return;
  // ADAPT: read status; if more_info_needed → re-answer requested fields and resubmit; if invoice → pay; POST /ledger/:id/observe
}

export function browse() {
  const actor = actors[exec.vu.idInTest % actors.length];
  req("GET", "/catalog/services", actor, undefined, "GET /catalog/services");
  req("GET", "/me/notifications", actor, undefined, "GET /me/notifications");
  sleep(1);
}

export function handleSummary(data: unknown) {
  return { [`${__ENV.K6_OUT_DIR || `../out/${RUN_ID}`}/k6-summary.json`]: JSON.stringify(data, null, 2) };
}
