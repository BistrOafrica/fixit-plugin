/**
 * Playwright for defect discovery. The suite never starts the API: global setup
 * asserts it is healthy. Front ends run as Vite dev servers proxying /api to
 * the API under test (same origin, no CORS surprises).
 *
 * ADAPT: ports, front-end dirs, API origin, persona list in support/constants.ts.
 */
import { defineConfig, devices } from "@playwright/test";

const API = process.env.E2E_API ?? "http://localhost:28081";
const PORTAL_PORT = 25174, ADMIN_PORT = 25173;

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./support/global-setup.ts",
  workers: 1, // personas and back-office state are shared
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { trace: "retain-on-failure", video: "retain-on-failure", screenshot: "only-on-failure", actionTimeout: 20_000, navigationTimeout: 45_000 },
  projects: [{
    name: "chromium",
    use: {
      ...devices["Desktop Chrome"],
      // WebGL (maps, canvas) on GPU-less CI runners.
      launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] },
    },
  }],
  webServer: [
    { command: `npx vite --port ${PORTAL_PORT} --strictPort`, cwd: "../webapp", port: PORTAL_PORT, reuseExistingServer: process.env.E2E_REUSE_SERVERS !== "0", timeout: 180_000, env: { VITE_API_BASE_URL: "/api", VITE_API_PROXY_TARGET: API } },
    { command: `npx vite --port ${ADMIN_PORT} --strictPort`, cwd: "../frontend", port: ADMIN_PORT, reuseExistingServer: process.env.E2E_REUSE_SERVERS !== "0", timeout: 180_000, env: { VITE_API_BASE_URL: "/api", VITE_API_PROXY_TARGET: API } },
  ],
});
