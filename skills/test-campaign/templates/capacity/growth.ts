/**
 * Growth curve: does a hot read path get slower as history grows?
 *
 *   tsx growth.ts --sizes 1000,3000,10000 --path "/v1/me/inbox" --as reviewer@x.test --n 40
 *
 * For each history size: seed up to that many rows (ADAPT seedHistory), then
 * time N sequential requests for ONE user with nothing else running, and
 * record p50/p95. Fits a line latency = a + b·rows; a positive slope b means an
 * O(n) path. Prints ms per 1,000 rows and an extrapolation to --target rows.
 * Writes growth.csv for the report chart.
 */
import { writeFileSync } from "node:fs";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d!; };
const SIZES = arg("sizes", "1000,3000,10000").split(",").map(Number);
const PATH = arg("path", "/v1/me/inbox");
const BASE = arg("base", "http://localhost:8081/api");
const N = Number(arg("n", "40"));
const TARGET = Number(arg("target", "2100000"));

async function seedHistory(rows: number): Promise<void> {
  // ADAPT: idempotently top the DB up to `rows` decided entities (bulk SQL, not the API — this is setup, not the system under test).
  throw new Error(`seedHistory(${rows}) not implemented`);
}
async function token(): Promise<string> {
  // ADAPT: log in as the measured user
  throw new Error("token() not implemented");
}
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;

const rows: Array<{ size: number; p50: number; p95: number }> = [];
for (const size of SIZES) {
  await seedHistory(size);
  const t = await token();
  const times: number[] = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const r = await fetch(`${BASE}${PATH}`, { headers: { Authorization: `Bearer ${t}` } });
    await r.arrayBuffer();
    if (!r.ok) throw new Error(`${PATH} → ${r.status}`);
    times.push(performance.now() - t0);
  }
  rows.push({ size, p50: pct(times, 50), p95: pct(times, 95) });
  console.log(`${size} rows: p50 ${rows.at(-1)!.p50.toFixed(1)} ms, p95 ${rows.at(-1)!.p95.toFixed(1)} ms`);
}

// least squares on p50
const n = rows.length, sx = rows.reduce((s, r) => s + r.size, 0), sy = rows.reduce((s, r) => s + r.p50, 0);
const sxx = rows.reduce((s, r) => s + r.size * r.size, 0), sxy = rows.reduce((s, r) => s + r.size * r.p50, 0);
const b = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1), a = (sy - b * sx) / n;
console.log(`slope ${(b * 1000).toFixed(2)} ms per 1,000 rows → at ${TARGET.toLocaleString()} rows ≈ ${((a + b * TARGET) / 1000).toFixed(1)} s per request`);
console.log(b * 1000 > 0.5 ? "FINDING: latency grows with history (O(n) path)" : "flat: no growth detected at these sizes");
writeFileSync("growth.csv", "rows,p50_ms,p95_ms\n" + rows.map((r) => `${r.size},${r.p50.toFixed(1)},${r.p95.toFixed(1)}`).join("\n") + "\n");
