/**
 * Standalone Playwright config for the QR-download decode guard.
 *
 * Deliberately separate from playwright.config.ts: these specs run pure
 * browser-context logic (SVG decode + canvas rasterization via
 * page.setContent) and need NO dev server, DB, or auth. Keeping them out
 * of the main e2e config avoids spinning up `npm run dev` for a unit-ish
 * real-browser check.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/qr-download",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "list" : "line",
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
