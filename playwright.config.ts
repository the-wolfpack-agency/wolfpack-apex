/**
 * Playwright configuration for wolfpack-apex (Instinct).
 *
 * Kept intentionally small — this repo's E2E surface is the verify smoke
 * suite. Additional suites can extend the testDir / testMatch when added.
 */
import { defineConfig, devices } from "@playwright/test";

const PROD_URL = process.env.PROD_URL?.replace(/\/$/, "");

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["**/*.spec.ts"],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: PROD_URL || "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  // Only auto-start a local server when we are NOT pointing at a deployed URL.
  webServer: PROD_URL
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:3000",
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
