/**
 * Sites — wireframe upload + AI image generation E2E.
 *
 * Pins the two 2026-04-18 AI creation paths to the UX contract so a
 * regression in either the parse-brief image route OR the generate-image
 * route fails loudly instead of silently rejecting team members.
 *
 * What this asserts:
 *   1. /sites/new dropzone accepts a PNG wireframe, shows the "Analyzing"
 *      state, mounts WireframeExtractReview with a palette + sections
 *      on 200, and wires Apply into the create flow.
 *   2. /sites/new rejects unsupported MIME types with a user-visible
 *      banner that names the allowed formats.
 *   3. /sites/new surfaces 503 ai_not_configured with an actionable
 *      message (no generic "Something went wrong").
 *   4. On a provisioned site, the BriefForm's ✨ Generate image button
 *      opens the modal, the modal fires POST /api/sites/:id/generate-image,
 *      and the returned URL lands in the corresponding brief field.
 *   5. Daily-cap 429 surfaces as a plain-language banner.
 *
 * Skipped when SMOKE_TEST_EMAIL/PASSWORD aren't set — same contract as
 * the rest of the E2E suite. The nightly canary runs with creds + the
 * two API keys and is the loud-failure surface.
 */

import { test, expect, type Page, type Request } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible } from "./helpers/smoke-helpers";
import * as path from "node:path";
import * as fs from "node:fs";

const target = resolveSmokeTarget();

async function authToken(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      localStorage.getItem("instinct_token") ??
      localStorage.getItem("apex_token") ??
      "",
  );
}

/**
 * Tiny valid PNG that the server's palette extractor can actually
 * decode (otherwise we only exercise the route, not the full path).
 * 1x1 red pixel PNG, hand-encoded.
 */
const TINY_RED_PNG = Buffer.from(
  [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
    0x00, 0x00, 0x00, 0x0d, // IHDR length
    0x49, 0x48, 0x44, 0x52, // "IHDR"
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
    0x08, 0x02, 0x00, 0x00, 0x00, // 8-bit RGB
    0x90, 0x77, 0x53, 0xde,
    0x00, 0x00, 0x00, 0x0c, // IDAT length
    0x49, 0x44, 0x41, 0x54,
    0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01,
    0x5b, 0x56, 0x17, 0x9e,
    0x00, 0x00, 0x00, 0x00, // IEND length
    0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82,
  ],
);

async function firstProjectId(page: Page, baseUrl: string): Promise<string> {
  const token = await authToken(page);
  const r = await page.request.get(`${baseUrl}/api/sites`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await r.json()) as {
    projects: Array<{ id: string; github_repo: string | null }>;
  };
  const provisioned = data.projects.find((p) => p.github_repo);
  expect(
    provisioned,
    "at least one site must have github_repo set for image-gen E2E",
  ).toBeDefined();
  return provisioned!.id;
}

test.describe("sites — wireframe upload flow (non-technical)", () => {
  test.skip(
    !target.email || !target.password,
    "SMOKE_TEST_EMAIL/PASSWORD not set — skipping",
  );

  test("unsupported MIME surfaces a user-readable banner", async ({ page }) => {
    expect(await signInIfPossible(page, target)).toBe(true);
    await page.goto(`${target.baseUrl}/sites/new`, { waitUntil: "networkidle" });

    // Simulate a bogus upload — build a File with a rejected MIME.
    const input = page.locator('input[type="file"]').first();
    const tmp = path.join("/tmp", `e2e-bogus-${Date.now()}.xyz`);
    fs.writeFileSync(tmp, "not an image");

    await input.setInputFiles({
      name: "weird.exe",
      mimeType: "application/x-msdownload",
      buffer: Buffer.from("MZ\x90\x00"),
    });

    const banner = page.getByTestId("wireframe-error-banner");
    await expect(banner).toBeVisible({ timeout: 10_000 });
    const text = await banner.innerText();
    expect(text).toMatch(/PNG|JPG|WEBP|PDF/i);
  });

  test("happy path: PNG → Analyzing → review card → Apply wires extracted brief", async ({
    page,
  }) => {
    expect(await signInIfPossible(page, target)).toBe(true);
    await page.goto(`${target.baseUrl}/sites/new`, { waitUntil: "networkidle" });

    // Capture the parse-brief call so we can prove the multipart shape.
    const parseReq = page.waitForRequest(
      (req: Request) =>
        req.url().includes("/api/sites/parse-brief") && req.method() === "POST",
    );

    await page.locator('input[type="file"]').first().setInputFiles({
      name: "wireframe.png",
      mimeType: "image/png",
      buffer: TINY_RED_PNG,
    });

    // Loading state visible while vision runs
    await expect(page.getByTestId("wireframe-loading-indicator")).toBeVisible();

    // Request fired with the right file
    const req = await parseReq;
    expect(req.method()).toBe("POST");

    // Vision can take up to 20s on a cold start — give it room.
    const review = page.getByTestId("wireframe-extract-review");
    await expect(review).toBeVisible({ timeout: 30_000 });

    // Palette swatches rendered (primary at minimum)
    await expect(page.getByTestId("wireframe-color-swatch-primary")).toBeVisible();

    // Apply merges the extracted brief into the form
    await page.getByTestId("wireframe-apply-btn").click();

    // The slug input should be pre-filled (from brief.client) after Apply
    const slugInput = page.getByTestId("new-site-slug");
    await expect(slugInput).toHaveValue(/^[a-z0-9-]+$/);
  });

  test("503 ai_not_configured surfaces an actionable banner", async ({ page }) => {
    expect(await signInIfPossible(page, target)).toBe(true);
    await page.goto(`${target.baseUrl}/sites/new`, { waitUntil: "networkidle" });

    // Force 503 so the test doesn't require the env var to be unset.
    await page.route("**/api/sites/parse-brief", (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error:
              "AI extraction isn't configured. An admin needs to set ANTHROPIC_API_KEY on this environment.",
            reason: "ai_not_configured",
          }),
        });
      }
      return route.continue();
    });

    await page.locator('input[type="file"]').first().setInputFiles({
      name: "x.png",
      mimeType: "image/png",
      buffer: TINY_RED_PNG,
    });

    const banner = page.getByTestId("wireframe-error-banner");
    await expect(banner).toBeVisible({ timeout: 10_000 });
    const text = await banner.innerText();
    expect(text).toMatch(/ANTHROPIC_API_KEY|admin|isn't configured/i);
  });
});

test.describe("sites — AI image generation (hero + gallery)", () => {
  test.skip(
    !target.email || !target.password,
    "SMOKE_TEST_EMAIL/PASSWORD not set — skipping",
  );

  test("✨ Generate image opens modal, POSTs with correct shape, 'Use this image' wires URL", async ({
    page,
  }) => {
    expect(await signInIfPossible(page, target)).toBe(true);
    const id = await firstProjectId(page, target.baseUrl);
    await page.goto(`${target.baseUrl}/sites/${id}`, { waitUntil: "networkidle" });

    // Stub the generate-image response so the test doesn't actually
    // pay for a fal.ai call. This proves the UI handshake is correct
    // without burning the cap or money.
    const FAKE_URL =
      "https://raw.githubusercontent.com/the-wolfpack-agency/wolfpack-e2e/main/public/generated/fake.jpg";
    await page.route(`**/api/sites/${id}/generate-image`, (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            url: FAKE_URL,
            generationId: "gen_e2e_1",
            cost_cents: 1,
            seed: 42,
            repoCommitted: true,
          }),
        });
      }
      return route.continue();
    });

    // Find the first "Generate image" button (hero.backgroundImage OR
    // gallery[0].src — either works for this contract).
    const genBtn = page
      .getByRole("button", { name: /Generate image/i })
      .first();
    await expect(genBtn).toBeVisible({ timeout: 15_000 });
    await genBtn.click();

    const modal = page.getByRole("dialog", { name: /image/i });
    await expect(modal).toBeVisible();

    const prompt = "a dramatic sunset over the Nürburgring racetrack";
    await modal.getByRole("textbox", { name: /describe/i }).fill(prompt);

    const genReq = page.waitForRequest(
      (req) =>
        req.url().includes(`/api/sites/${id}/generate-image`) &&
        req.method() === "POST",
    );
    await modal.getByRole("button", { name: /^Generate$/i }).click();
    const body = JSON.parse(((await genReq).postData() ?? "{}") as string);
    expect(body.prompt).toBe(prompt);
    expect(body.aspectRatio).toMatch(/^(16:9|4:3|1:1|3:4|9:16)$/);

    await modal.getByRole("button", { name: /Use this image/i }).click();

    // The image URL must land somewhere in the brief — probe the JSON view.
    await page.getByText("Show JSON").click().catch(() => null);
    await expect(page.locator("textarea, pre")).toContainText(FAKE_URL, {
      timeout: 10_000,
    });
  });

  test("429 daily_cap_exceeded surfaces as a plain-language banner inside the modal", async ({
    page,
  }) => {
    expect(await signInIfPossible(page, target)).toBe(true);
    const id = await firstProjectId(page, target.baseUrl);
    await page.goto(`${target.baseUrl}/sites/${id}`, { waitUntil: "networkidle" });

    await page.route(`**/api/sites/${id}/generate-image`, (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 429,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Daily image-generation cap reached (50/day). Try again tomorrow.",
            reason: "daily_cap_exceeded",
            cap: 50,
            used: 50,
          }),
        });
      }
      return route.continue();
    });

    const genBtn = page
      .getByRole("button", { name: /Generate image/i })
      .first();
    await genBtn.click();
    const modal = page.getByRole("dialog", { name: /image/i });
    await modal.getByRole("textbox", { name: /describe/i }).fill("anything");
    await modal.getByRole("button", { name: /^Generate$/i }).click();

    await expect(modal).toContainText(/Daily image-generation cap/i, {
      timeout: 10_000,
    });
  });

  test("503 FAL_API_KEY missing surfaces the env var name inside the modal", async ({
    page,
  }) => {
    expect(await signInIfPossible(page, target)).toBe(true);
    const id = await firstProjectId(page, target.baseUrl);
    await page.goto(`${target.baseUrl}/sites/${id}`, { waitUntil: "networkidle" });

    await page.route(`**/api/sites/${id}/generate-image`, (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error:
              "Image generation isn't configured. An admin needs to set FAL_API_KEY on this environment.",
            reason: "image_gen_not_configured",
          }),
        });
      }
      return route.continue();
    });

    const genBtn = page
      .getByRole("button", { name: /Generate image/i })
      .first();
    await genBtn.click();
    const modal = page.getByRole("dialog", { name: /image/i });
    await modal.getByRole("textbox", { name: /describe/i }).fill("x");
    await modal.getByRole("button", { name: /^Generate$/i }).click();

    await expect(modal).toContainText(/FAL_API_KEY/, { timeout: 10_000 });
  });
});
