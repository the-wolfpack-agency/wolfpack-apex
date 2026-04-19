/**
 * Sites — multi-frame wireframe upload E2E.
 *
 * Pins the 2026-04-19 multi-page extractor UX to a loud-failure suite:
 *   1. Dropping 2 PNGs renders a 2-thumbnail ordered grid.
 *   2. Removing a thumbnail shrinks the grid.
 *   3. Clicking "Analyze frames" POSTs `files[]` with both frames (not
 *      `file`).
 *   4. A 200 multi-frame response mounts WireframeExtractReview with a
 *      palette — same surface we lean on for the single-frame path.
 *
 * The route is stubbed for this suite so we don't burn Claude vision
 * tokens on every CI run. Single-frame + auth gates are covered by the
 * sibling `sites-wireframe-and-image-gen.spec.ts`.
 *
 * Skipped when SMOKE_TEST_EMAIL/PASSWORD aren't set — same gate as the
 * rest of the E2E suite.
 */

import { test, expect, type Page, type Request } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

/**
 * Tiny valid PNG — same hand-encoded 1x1 red pixel used by
 * sites-wireframe-and-image-gen.spec.ts. Good enough to make the server
 * happy about MIME + size; the test stubs the response anyway.
 */
const TINY_RED_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00,
  0x90, 0x77, 0x53, 0xde,
  0x00, 0x00, 0x00, 0x0c,
  0x49, 0x44, 0x41, 0x54,
  0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01,
  0x5b, 0x56, 0x17, 0x9e,
  0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

const MULTI_FRAME_RESPONSE = {
  brief: {
    client: "acme-co",
    product: { name: "Acme" },
    pages: [
      {
        route: "/",
        sections: [{ type: "hero", heading: "From page 1" }],
      },
      {
        route: "/about",
        sections: [{ type: "text", body: "From page 2" }],
      },
    ],
  },
  source: "vision",
  confidence: "high",
  metadata: {
    generationId: "site_brief_gen_e2e_multi",
    extractedColors: ["#112233", "#445566", "#778899"],
    detectedFont: "Inter",
    latencyMs: 420,
    tokensIn: 800,
    tokensOut: 400,
    costCents: 4,
    model: "claude-haiku-4-5-20251001",
    frameCount: 2,
  },
};

async function dropTwoFrames(page: Page): Promise<void> {
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles([
    { name: "page-1.png", mimeType: "image/png", buffer: TINY_RED_PNG },
    { name: "page-2.png", mimeType: "image/png", buffer: TINY_RED_PNG },
  ]);
}

test.describe("sites — multi-frame wireframe upload", () => {
  test.skip(
    !target.email || !target.password,
    "SMOKE_TEST_EMAIL/PASSWORD not set — skipping",
  );

  test("drops 2 frames, shows ordered thumbnails, submits as files[]", async ({ page }) => {
    expect(await signInIfPossible(page, target)).toBe(true);
    await page.goto(`${target.baseUrl}/sites/new`, { waitUntil: "networkidle" });

    // Stub the parse-brief route so the E2E never hits the vision API.
    await page.route("**/api/sites/parse-brief", (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MULTI_FRAME_RESPONSE),
        });
      }
      return route.continue();
    });

    await dropTwoFrames(page);

    // Both ordered thumbnails render.
    await expect(page.getByTestId("multi-frame-thumb-0")).toBeVisible();
    await expect(page.getByTestId("multi-frame-thumb-1")).toBeVisible();

    // Removing a thumbnail shrinks the grid.
    await page.getByTestId("multi-frame-remove-0").click();
    await expect(page.getByTestId("multi-frame-thumb-0")).toBeVisible();
    await expect(page.getByTestId("multi-frame-thumb-1")).toHaveCount(0);

    // Re-drop and submit — capture the request to prove files[] shape.
    const input = page.locator('input[type="file"]').first();
    await input.setInputFiles([
      { name: "page-1.png", mimeType: "image/png", buffer: TINY_RED_PNG },
    ]);
    // Now we have 2 frames again (the leftover + one new).
    await expect(page.getByTestId("multi-frame-thumb-1")).toBeVisible();

    const parseReq = page.waitForRequest(
      (req: Request) =>
        req.url().includes("/api/sites/parse-brief") && req.method() === "POST",
    );
    await page.getByTestId("multi-frame-submit").click();
    const req = await parseReq;

    // Inspect the multipart body — we expect `files[]` entries (NOT a
    // single `file`) for a 2-frame submit. Playwright's Request exposes
    // postData() as the raw multipart body.
    const body = req.postData() ?? "";
    expect(body).toContain('name="files[]"');
    expect(body).not.toMatch(/name="file"\s*\r\n/);

    // The review card mounts with the extracted brief.
    const review = page.getByTestId("wireframe-extract-review");
    await expect(review).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("wireframe-color-swatch-primary")).toBeVisible();
  });
});
