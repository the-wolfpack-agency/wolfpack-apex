/**
 * Standalone Playwright config for the spec-diff fidelity fixtures.
 *
 * Deliberately separate from playwright.config.ts, and modelled on
 * playwright.qr.config.ts: these specs run the real measurement chain against
 * .html files on disk and need NO dev server, database, or auth. Keeping them
 * out of the main e2e config avoids spinning up `npm run dev` for what is a
 * real-browser unit test.
 *
 * A real browser is not optional here. The code under test reads a live DOM
 * (getBoundingClientRect, getComputedStyle, canvas glyph metrics); jsdom has no
 * layout engine, so every box measures 0x0 and an assertion about a 66px header
 * would pass or fail for reasons that have nothing to do with the page.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/spec-diff",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Fixtures on disk with no network: a retry would only ever hide a real
  // regression in the measurement chain.
  retries: 0,
  reporter: process.env.CI ? "list" : "line",
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
