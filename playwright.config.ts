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
  // Where traces, screenshots, and videos for failing tests are written.
  // CI uploads this dir as an artifact so every real failure is debuggable.
  outputDir: "./test-results",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // retries:1 in CI is HONEST, not masking. Playwright marks a test that
  // failed-then-passed as "flaky" (a distinct, visible outcome) rather than
  // a clean pass — so a genuinely intermittent bug still shows up in the
  // report. The retry only absorbs the unavoidable first-hit cold-route
  // compile after the readiness gate has already confirmed the app is up.
  // Locally retries:0 so a developer sees failures immediately.
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  // In CI emit BOTH the GitHub annotations (inline PR/check feedback) AND an
  // HTML report on disk that the upload-artifact step ships, so no diagnostic
  // is lost. Locally the list reporter is enough.
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : "list",
  timeout: 60_000,
  // 15s (was 5s). A just-woken preview pays a one-time per-route compile on
  // the first hit even after the readiness gate confirms the app is up, so a
  // 5s expect-timeout on the first locator can flake. 15s absorbs that cold
  // hit without masking a genuinely missing element.
  expect: { timeout: 15_000 },

  use: {
    baseURL: PROD_URL || "http://localhost:3000",
    // Capture a full trace whenever a test fails so any genuine failure is
    // fully debuggable from the uploaded artifact (no data lost). With
    // retries:1, this records the failing first attempt as well.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Keep the failing run's video too — cheap insurance for the rare
    // failure that a trace alone doesn't explain.
    video: "retain-on-failure",
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
