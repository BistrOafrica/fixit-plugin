/**
 * Playwright global setup: API healthy → idempotent seed → warm dev servers →
 * log every persona in THROUGH THE REAL UI → save storageState per persona.
 *
 * ADAPT: constants (personas, URLs), seed(), loginAs(page, persona).
 */
import { chromium, type FullConfig } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { API_ORIGIN, PERSONAS, PORTAL_URL, ADMIN_URL, storageStatePath, type Persona } from "./constants"; // ADAPT
import { loginAs } from "./login";   // ADAPT: fills the real sign-in form
import { seed } from "../scripts/seed"; // ADAPT: idempotent, DB-name guarded

export default async function globalSetup(_: FullConfig): Promise<void> {
  const health = await fetch(`${API_ORIGIN}/healthz`).catch(() => null);
  if (!health?.ok) throw new Error(`API not healthy at ${API_ORIGIN} — start the stack first.`);
  if (process.env.E2E_SKIP_SEED !== "1") await seed();

  mkdirSync(".auth", { recursive: true });
  const browser = await chromium.launch();
  try {
    // Cold Vite servers optimise deps and may force-reload: warm both, with retries.
    const warm = await browser.newPage();
    for (const url of [PORTAL_URL, ADMIN_URL]) {
      for (let attempt = 1; ; attempt++) {
        try { await warm.goto(url, { timeout: 180_000, waitUntil: "networkidle" }); break; }
        catch (e) { if (attempt >= 3) throw e; }
      }
    }
    await warm.close();

    for (const persona of Object.keys(PERSONAS) as Persona[]) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await loginAs(page, persona);
      await context.storageState({ path: storageStatePath(persona) });
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
