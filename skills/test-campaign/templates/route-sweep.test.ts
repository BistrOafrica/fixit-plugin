/**
 * Default-deny route sweep (Express 4). Every route must be gated, public,
 * guarded in-handler WITH a written reason, or on the KNOWN_UNGATED ratchet.
 *
 * Mark gates in your RBAC middleware:   (fn as any)[Symbol.for("app.rbacGate")] = true
 * ADAPT: createApp import, PUBLIC_PREFIXES, IN_HANDLER_GUARDED, the minimum route count.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/http/app"; // ADAPT

const GATE = Symbol.for("app.rbacGate");
const PUBLIC_PREFIXES = ["GET /healthz", "GET /readyz", "POST /api/v1/auth/", "GET /api/v1/public/"];
const IN_HANDLER_GUARDED: Array<{ pattern: RegExp; why: string }> = [
  // { pattern: /^GET \/api\/v1\/me\//, why: "scoped to req.user in the handler" },
];
const KNOWN_UNGATED = new Set<string>([
  // "GET /api/v1/items"  (BUG SEC-01)
]);

interface Route { key: string; gated: boolean }
function prefixOf(layer: any): string {
  const src: string = layer.regexp?.source ?? "";
  return src.replace(/^\^/, "").replace(/\\\/\?\(\?=\\\/\|\$\)$/i, "").replace(/\(\?:\\\/\(\[\^\\\/\]\+\?\)\)/g, "/:param").replace(/\\\//g, "/").replace(/\$$/, "");
}
function walkStack(stack: any[], prefix: string, inheritedGate: boolean, out: Route[]): void {
  let gate = inheritedGate;
  for (const layer of stack) {
    if (layer.route) {
      const handlers = layer.route.stack.map((s: any) => s.handle);
      const gated = gate || handlers.some((h: any) => h?.[GATE]);
      for (const m of Object.keys(layer.route.methods)) out.push({ key: `${m.toUpperCase()} ${prefix}${layer.route.path}`.replace(/\/+/g, "/"), gated });
    } else if (layer.name === "router" && layer.handle?.stack) {
      walkStack(layer.handle.stack, prefix + prefixOf(layer), gate, out);
    } else if (layer.handle?.[GATE]) {
      gate = true; // router-level .use(gate) covers every later route in this router
    }
  }
}

const routes: Route[] = [];
walkStack((createApp() as any)._router.stack, "", false, routes);
const ungated = routes.filter((r) => !r.gated && !PUBLIC_PREFIXES.some((p) => r.key.startsWith(p)) && !IN_HANDLER_GUARDED.some((g) => g.pattern.test(r.key)));

test("the sweep sees the whole app", () => assert.ok(routes.length > 50, `only ${routes.length} routes found — the walker is broken`)); // ADAPT the floor

test("every route is gated, public, or justified", () => {
  const unexpected = ungated.map((r) => r.key).filter((k) => !KNOWN_UNGATED.has(k)).sort();
  if (unexpected.length) console.error(`ungated routes:\n  ${unexpected.join("\n  ")}`); // print before asserting: open handles may swallow diagnostics
  assert.deepEqual(unexpected, []);
});

test("every KNOWN_UNGATED entry is still ungated (delete fixed ones)", () => {
  const now = new Set(ungated.map((r) => r.key));
  assert.deepEqual([...KNOWN_UNGATED].filter((k) => !now.has(k)), []);
});
