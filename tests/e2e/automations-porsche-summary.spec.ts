/**
 * E2E: per-class summary page renders cleanly.
 *
 * Strategy — DB seeding the porsche-classes table requires a Postgres
 * URL the test harness doesn't reliably have. Instead, we intercept
 * the assembled-summary API response via `page.route()` and assert
 * that the UI renders the contract-shaped JSON correctly. That covers
 * the contract test plan: HTTP 200, every key section present, no CSP
 * violations, copy/download buttons visible.
 *
 * When the env exposes SMOKE_TEST_EMAIL/PASSWORD we sign in first;
 * otherwise we set a localStorage `instinct_token` so the page's
 * blank-dashboard guardrail (redirect-to-login when no token) lets us
 * past. In either case we never mount the real DB-backed route — the
 * intercept is the seed.
 */
import { test, expect } from "@playwright/test";
import {
  collectConsoleAndNetworkFailures,
  resolveSmokeTarget,
  signInIfPossible,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const CLASS_KEY = "BA101|2026-04-13|Westlake";
const ENCODED = encodeURIComponent(CLASS_KEY);
const PAGE_URL = `/automations/porsche-classes/summaries/${ENCODED}`;
const API_URL = `**/api/automations/porsche-classes/summaries/${ENCODED}`;

const FAKE_SUMMARY = {
  class_key: CLASS_KEY,
  course_type: "BA101",
  class_date: "2026-04-13",
  location: "Westlake",
  sources: {
    porsche_xlsx: 1,
    cognito_coordinator: 1,
    cognito_instructor: 1,
    survey: 0,
  },
  participants: [
    "alice smith",
    "bob jones",
    "carla lee",
  ],
  coordinator_notes: [
    {
      author: "Amy Federman",
      note:
        "Overall Hotel Experience: Excellent! Recommended to move Asia lunch to another day.",
    },
  ],
  instructor_notes: [
    {
      author: "Jen Eby",
      note:
        "Please provide details:: Deleted entries for Smart Goals & SWOT",
    },
  ],
  survey: null,
  open_exceptions: [
    {
      id: "exc-1",
      automation_id: "porsche-classes",
      artifact_id: "artifact-survey-1",
      kind: "parse_failure",
      detail:
        "Survey format not yet specified — provide a real fixture and update parser-survey.ts",
      status: "open",
      resolved_by: null,
      resolved_at: null,
      created_at: "2026-04-21T10:00:00.000Z",
    },
  ],
  generated_at: "2026-04-21T15:00:00.000Z",
};

test.describe("Porsche class summary E2E", () => {
  test("renders the print-friendly summary with no CSP violations", async ({
    page,
  }) => {
    // Auth: prefer real sign-in; else stub a token so the page stops
    // bouncing to /login. The intercepted API response means the route
    // never actually validates the token, so this is safe in test.
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) {
      await page.goto(`${target.baseUrl}/`, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => {
        localStorage.setItem("instinct_token", "test-token-not-validated");
        localStorage.setItem(
          "instinct_user",
          JSON.stringify({
            id: "u-test",
            role: "ops",
            name: "Test",
            email: "test@instinct.local",
          }),
        );
      });
    }

    // Intercept the assembler API.
    await page.route(API_URL, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ summary: FAKE_SUMMARY }),
      });
    });

    const snapshot = collectConsoleAndNetworkFailures(page);

    const response = await page.goto(`${target.baseUrl}${PAGE_URL}`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(response?.status(), "page HTTP status").toBe(200);

    // Wait for the summary page to render past the loading shell.
    await expect(
      page.getByTestId("summary-page"),
      "summary-page testid renders",
    ).toBeVisible({ timeout: 10_000 });

    // Header — class meta.
    const header = page.getByTestId("summary-header");
    await expect(header).toContainText("BA101");
    await expect(header).toContainText("2026-04-13");
    await expect(header).toContainText("Westlake");

    // Action buttons present.
    await expect(page.getByTestId("copy-plain-text")).toBeVisible();
    await expect(page.getByTestId("download-json")).toBeVisible();

    // Open-exceptions banner shows the survey TODO.
    await expect(page.getByTestId("open-exceptions-banner")).toBeVisible();
    await expect(page.getByTestId("open-exceptions-banner")).toContainText(
      "parse_failure",
    );

    // Attendance shows the canonical participant count + roster.
    await expect(page.getByTestId("attendance-section")).toContainText(
      "Total: 3",
    );
    await expect(page.getByTestId("attendance-section")).toContainText(
      "alice smith",
    );

    // Coordinator + instructor sections render their notes.
    await expect(page.getByTestId("coordinator-section")).toContainText(
      "Amy Federman",
    );
    await expect(page.getByTestId("coordinator-section")).toContainText(
      "Overall Hotel Experience",
    );
    await expect(page.getByTestId("instructor-section")).toContainText(
      "Jen Eby",
    );

    // Survey rollup shows the placeholder copy.
    await expect(page.getByTestId("survey-section")).toContainText(
      /survey integration pending/i,
    );

    // 3-second idle window for async CSP/network failures to surface.
    await page.waitForTimeout(3_000);
    const failures = snapshot();
    // Filter out 401s on the analytics endpoint — they're not the
    // page's fault, they happen because we're not really logged in.
    const blocking = failures.filter(
      (f) =>
        !f.detail.includes("/api/analytics") &&
        !f.detail.includes("/api/auth/refresh"),
    );
    expect(
      blocking,
      `CSP/network failures on ${PAGE_URL}:\n${blocking
        .map((f) => `  - [${f.kind}] ${f.detail}`)
        .join("\n")}`,
    ).toEqual([]);
  });

  test("renders a clean error state when the API returns 404", async ({
    page,
  }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) {
      await page.goto(`${target.baseUrl}/`, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => {
        localStorage.setItem("instinct_token", "test-token-not-validated");
        localStorage.setItem(
          "instinct_user",
          JSON.stringify({
            id: "u-test",
            role: "ops",
            name: "Test",
            email: "test@instinct.local",
          }),
        );
      });
    }

    await page.route(API_URL, async (route) => {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "no snapshots for this class" }),
      });
    });

    const response = await page.goto(`${target.baseUrl}${PAGE_URL}`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(response?.status(), "page HTTP status").toBe(200);
    await expect(page.getByTestId("summary-error")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("summary-error")).toContainText(
      /No data for this class/i,
    );
  });
});
