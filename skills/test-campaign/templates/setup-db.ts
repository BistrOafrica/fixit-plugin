/**
 * Prepare the isolated integration-test database.   tsx setup-db.ts [--force]
 *
 * - Refuses any database whose name does not end in `_test`.
 * - Rebuilds (drop → create → migrate → seed from the committed source of truth)
 *   only when the fingerprint of schema + migrations + seed sources changed;
 *   the fingerprint is stored inside the test DB.
 *
 * ADAPT: FINGERPRINT_INPUTS, MIGRATE and SEED commands, the admin connection.
 * Uses `pg`; swap for your ORM's raw client if you prefer.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import pg from "pg";

const ROOT = process.cwd();
const FINGERPRINT_INPUTS = ["prisma/schema.prisma", "prisma/migrations", "catalog"]; // ADAPT
const MIGRATE = ["npx", "prisma", "migrate", "deploy"];                              // ADAPT
const SEED = ["npx", "tsx", "prisma/seed.ts"];                                       // ADAPT
const META = "_test_meta";

export const testDatabaseUrl = () => process.env.TEST_DATABASE_URL || "postgresql://app:app@localhost:5432/app_test";

export function assertTestDb(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!/_test$/.test(name)) throw new Error(`Refusing to use database "${name}" for tests: the name must end in "_test".`);
}

function hashInto(p: string, h: ReturnType<typeof createHash>): void {
  if (!existsSync(p)) return;
  if (statSync(p).isDirectory()) for (const e of readdirSync(p).sort()) hashInto(join(p, e), h);
  else { h.update(relative(ROOT, p)); h.update(readFileSync(p)); }
}
export function fingerprint(): string {
  const h = createHash("sha256");
  for (const p of FINGERPRINT_INPUTS) hashInto(join(ROOT, p), h);
  return h.digest("hex");
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

export async function prepareTestDatabase(opts: { force?: boolean } = {}): Promise<string> {
  const url = testDatabaseUrl();
  assertTestDb(url);
  const name = new URL(url).pathname.slice(1).replace(/"/g, "");
  const admin = Object.assign(new URL(url), { pathname: "/postgres" }).toString();
  const want = fingerprint();
  const have = await withClient(url, async (c) => (await c.query(`SELECT hash FROM "${META}" LIMIT 1`)).rows[0]?.hash).catch(() => null);
  if (!opts.force && have === want) { console.log("test database up to date"); return url; }

  console.log("preparing test database (recreate + migrate + seed)…");
  await withClient(admin, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${name}"`);
  });
  const env = { ...process.env, DATABASE_URL: url, NODE_ENV: "test" };
  execFileSync(MIGRATE[0]!, MIGRATE.slice(1), { cwd: ROOT, stdio: "inherit", env });
  execFileSync(SEED[0]!, SEED.slice(1), { cwd: ROOT, stdio: "inherit", env });
  await withClient(url, async (c) => {
    await c.query(`CREATE TABLE IF NOT EXISTS "${META}" (hash text NOT NULL)`);
    await c.query(`DELETE FROM "${META}"`);
    await c.query(`INSERT INTO "${META}" (hash) VALUES ($1)`, [want]);
  });
  console.log("test database ready");
  return url;
}

if (process.argv[1]?.endsWith("setup-db.ts")) {
  prepareTestDatabase({ force: process.argv.includes("--force") }).catch((e) => { console.error(e.message ?? e); process.exit(1); });
}
