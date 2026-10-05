/**
 * Shared MSW server for front-end contract tests (Vitest/Jest).
 *
 * setup file:
 *   beforeAll(() => server.listen({ onUnhandledRequest: "error" }));   // any unstubbed call fails
 *   afterEach(() => { cleanup(); server.resetHandlers(); localStorage.clear(); sessionStorage.clear(); vi.useRealTimers(); });
 *   afterAll(() => server.close());
 *
 * In a test:
 *   const calls = stubApi("patch", "/v1/workloads/:id", { data: wireWorkload({ assignee: "u-9" }) });
 *   const res = await updateWorkload("w1", { assignee: "u-9" });
 *   expect(calls[0].body).toEqual({ assignee_id: "u-9" });   // what went on the wire
 *   expect(res?.assignee).toBe("u-9");                        // how the response was decoded
 *
 * ADAPT: API_BASE must equal the app's base URL in the test env.
 */
import { http, HttpResponse, type JsonBodyType, type PathParams } from "msw";
import { setupServer } from "msw/node";

export const API_BASE = "http://api.test/api";
export const server = setupServer(); // baseline deliberately empty

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";
export interface CapturedRequest { method: string; pathname: string; search: URLSearchParams; params: PathParams; body: unknown; headers: Headers }
type Resolver = JsonBodyType | ((req: { body: unknown; params: PathParams; search: URLSearchParams }) => JsonBodyType);

export function stubApi(method: HttpMethod, path: string, response: Resolver = { data: null }, init: { status?: number } = {}): CapturedRequest[] {
  const calls: CapturedRequest[] = [];
  server.use(
    http[method](`${API_BASE}${path}`, async ({ request, params }) => {
      const text = await request.text();
      let body: unknown;
      try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
      const url = new URL(request.url);
      calls.push({ method: request.method, pathname: url.pathname, search: url.searchParams, params, body, headers: request.headers });
      const payload = typeof response === "function" ? response({ body, params, search: url.searchParams }) : response;
      if (init.status === 204) return new HttpResponse(null, { status: 204 });
      return HttpResponse.json(payload, { status: init.status ?? 200 });
    }),
  );
  return calls;
}
