/**
 * Lane runner.   tsx run-lanes.ts --lane unit|int|sim|all [--no-db] [files…]
 *
 *   *.unit.test.ts  no DB, fully parallel
 *   *.test.ts       integration against the isolated DB, serial
 *   *.sim.test.ts   process simulations, serial
 *
 * Children get a fixed env that overrides .env files. A per-test timeout +
 * force-exit makes a stray open handle fail loudly instead of hanging CI.
 * Coverage: run this under c8 (`c8 tsx run-lanes.ts --lane all`); c8 follows
 * children via NODE_V8_COVERAGE.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { prepareTestDatabase, testDatabaseUrl } from "./setup-db";

type Lane = "unit" | "int" | "sim";
export const laneOf = (f: string): Lane => (f.endsWith(".unit.test.ts") ? "unit" : f.endsWith(".sim.test.ts") ? "sim" : "int");

function find(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) find(p, out);
    else if (p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const args = process.argv.slice(2);
const want = (args[args.indexOf("--lane") + 1] ?? "all") as Lane | "all";
const explicit = args.filter((a) => a.endsWith(".test.ts"));
const files = (explicit.length ? explicit : find("src")).filter((f) => want === "all" || laneOf(f) === want);

const env = {
  ...process.env,
  DATABASE_URL: testDatabaseUrl(),
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  AUTH_RATE_LIMIT_MAX: "100000",   // ADAPT: anything a single test IP would trip
  JWT_SECRET: "test-only-secret",  // ADAPT: test secrets
};

let failed = false;
const needsDb = files.some((f) => laneOf(f) !== "unit");
if (needsDb && !args.includes("--no-db")) await prepareTestDatabase();
for (const lane of ["unit", "int", "sim"] as Lane[]) {
  const set = files.filter((f) => laneOf(f) === lane);
  if (!set.length) continue;
  const concurrency = lane === "unit" ? availableParallelism() : 1;
  console.log(`\n── ${lane} lane (${set.length} files, concurrency ${concurrency})`);
  const r = spawnSync(process.execPath, ["--import", "tsx", "--test", `--test-concurrency=${concurrency}`, "--test-timeout=120000", "--test-force-exit", ...set], { stdio: "inherit", env });
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
