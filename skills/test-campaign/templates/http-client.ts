/**
 * Act as a principal against the real app, without a port.
 *
 *   await as(officer).post("/v1/approvals/123/decision", { action: "approve" }).expect(200);
 *   await anon().get("/v1/admin/users").expect(401);
 *   await withToken(mfaToken).get("/v1/auth/profile").expect(401);   // token-type confusion
 *
 * ADAPT: createApp import, signAccessToken, API prefix.
 */
import request from "supertest";
import { createApp } from "../src/http/app";          // ADAPT
import { signAccessToken } from "../src/lib/tokens";  // ADAPT
import { assertTestDb, testDatabaseUrl } from "./setup-db";

assertTestDb(testDatabaseUrl()); // re-assert the guard wherever the harness touches data

const API = "/api/v1"; // ADAPT
let app: ReturnType<typeof createApp> | undefined;
const testApp = () => (app ??= createApp());

type Req = request.Test;
export interface Client {
  get(p: string): Req; post(p: string, b?: unknown): Req; put(p: string, b?: unknown): Req;
  patch(p: string, b?: unknown): Req; delete(p: string): Req;
}

function client(token: string | null): Client {
  const url = (p: string) => (p.startsWith("/api/") || p.startsWith("/healthz") || p.startsWith("/readyz") ? p : `${API}${p}`);
  const auth = (t: Req) => (token ? t.set("Authorization", `Bearer ${token}`) : t);
  const agent = request(testApp());
  return {
    get: (p) => auth(agent.get(url(p))),
    post: (p, b) => auth(agent.post(url(p))).send(b as object),
    put: (p, b) => auth(agent.put(url(p))).send(b as object),
    patch: (p, b) => auth(agent.patch(url(p))).send(b as object),
    delete: (p) => auth(agent.delete(url(p))),
  };
}

export const tokenFor = (user: { id: string; roles: string[] }) => signAccessToken({ sub: user.id, roles: user.roles });
export const as = (user: { id: string; roles: string[] }) => client(tokenFor(user));
export const anon = () => client(null);
export const withToken = (t: string) => client(t);

/** Unique ids so tests never truncate or collide. */
let counter = 0;
export const uniq = (prefix: string) => `${prefix}-${process.pid.toString(36)}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
