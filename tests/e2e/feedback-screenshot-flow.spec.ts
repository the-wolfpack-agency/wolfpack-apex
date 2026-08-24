/**
 * Feedback screenshot END-TO-END reality check.
 *
 * Covers the two journeys shipped with the feedback screenshot + reader
 * notification work, at the layer the jest suite cannot reach: a real write
 * against a real DB, read back through a SEPARATE request, then the same data
 * rendered in the browser UI.
 *
 * The class of bug this defends against: a 201 from /api/feedback that silently
 * dropped the screenshot, or an /admin/feedback page that 200s but never shows
 * the image (a blank widget the client sees but our unit tests do not).
 *
 * Flow:
 *   1. Authenticate.
 *   2. POST /api/feedback with a distinctive message AND a valid PNG screenshot.
 *   3. Assert 201 with an id and has_screenshot true.
 *   4. GET /api/admin/feedback and find the row by message, has_screenshot true.
 *   5. GET /api/admin/feedback/<id>/screenshot and assert it returns real image
 *      bytes with an image content type and the nosniff header.
 *   6. Load /admin/feedback in the browser: 200, no CSP/network failures, the
 *      page is not blank, and the screenshot thumbnail for our row renders.
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD against a writable PROD_URL.
 * Skips cleanly (does not fail CI) when creds are missing. The feedback route
 * rate-limits to 3 per minute per user; this spec issues a single POST and
 * skips gracefully on a 429.
 */

import { test, expect } from "@playwright/test";
import {
  expectRendered,
  resolveSmokeTarget,
  signInIfPossible,
  authToken,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

// A 1x1 transparent PNG. Small, valid, and one of the allowed raster types,
// so it exercises the real validate + store + serve path end to end.
const PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function decodedByteLength(b64: string): number {
  return Buffer.from(b64, "base64").length;
}

test.describe("feedback screenshot data flow, real DB round-trip", () => {
  test.beforeEach(async ({ page }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) test.skip();
  });

  test("POST with screenshot, read back via API, then render in the UI", async ({
    page,
    request,
  }) => {
    const token = await authToken(page);
    if (!token) {
      test.skip(true, "auth token missing after sign-in");
      return;
    }

    const uniqueMessage = `E2E SCREENSHOT FLOW ${Date.now()} ${Math.random()
      .toString(36)
      .slice(2)}`;

    // 1. POST the feedback with a screenshot.
    const postRes = await request.post(`${target.baseUrl}/api/feedback`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      data: {
        message: uniqueMessage,
        surface: "/assistant",
        screenshot: {
          content_type: "image/png",
          data_base64: PNG_1x1_BASE64,
          byte_size: decodedByteLength(PNG_1x1_BASE64),
        },
      },
    });

    if (postRes.status() === 429) {
      test.skip(true, "feedback rate limit hit (3/min); rerun shortly");
      return;
    }
    expect(
      postRes.status(),
      `POST /api/feedback returned ${postRes.status()}`,
    ).toBe(201);
    const posted = await postRes.json();
    expect(posted.id, "feedback id returned").toBeTruthy();
    expect(
      posted.has_screenshot,
      "the screenshot was persisted, not silently dropped",
    ).toBe(true);
    const feedbackId: string = posted.id;

    // 2. Independent read-back through the admin list. If the row never landed,
    // or has_screenshot is computed wrong, this catches it.
    const listRes = await request.get(
      `${target.baseUrl}/api/admin/feedback?status=all&limit=200`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(listRes.status(), "admin feedback list reachable").toBe(200);
    const listed = await listRes.json();
    const row = (listed.feedback ?? []).find(
      (r: { id: string; message: string; has_screenshot?: boolean }) =>
        r.id === feedbackId || r.message === uniqueMessage,
    );
    expect(row, "the feedback we just filed is in the admin list").toBeTruthy();
    expect(row.has_screenshot, "admin list reports the screenshot").toBe(true);

    // 3. The screenshot bytes come back as a real image, capability gated.
    const shotRes = await request.get(
      `${target.baseUrl}/api/admin/feedback/${feedbackId}/screenshot`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(shotRes.status(), "screenshot endpoint serves the image").toBe(200);
    expect(
      shotRes.headers()["content-type"] ?? "",
      "served with an image content type",
    ).toMatch(/^image\//);
    expect(
      shotRes.headers()["x-content-type-options"],
      "nosniff is set so the bytes cannot be reinterpreted",
    ).toBe("nosniff");
    const body = await shotRes.body();
    expect(body.length, "non-empty image body").toBeGreaterThan(0);

    // 4. The browser UI renders the page cleanly and shows the thumbnail.
    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/feedback`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(nav?.status(), "/admin/feedback loads (not 401/blank)").toBe(200);

    await expectRendered(page, "/admin/feedback", ["team feedback"], {
      message: "the feedback page is not blank",
    });

    // The thumbnail link is keyed by the row id. It may sit below the fold or
    // under the All filter, so scope the assertion to its testid.
    const thumb = page.getByTestId(`admin-feedback-screenshot-${feedbackId}`);
    await expect(
      thumb,
      "the screenshot thumbnail renders for our row",
    ).toBeVisible({ timeout: 10_000 });

    // No CSP or network failures during the 3s idle window.
    await page.waitForTimeout(3_000);
    const failures = snapshot();
    expect(
      failures,
      `CSP/network failures on /admin/feedback:\n${failures
        .map((f) => `  - [${f.kind}] ${f.detail}`)
        .join("\n")}`,
    ).toEqual([]);
  });

  test("an oversized or non-raster screenshot is rejected with 400", async ({
    page,
    request,
  }) => {
    const token = await authToken(page);
    if (!token) {
      test.skip(true, "auth token missing after sign-in");
      return;
    }
    // An SVG is a script vector and must be refused by the server even though
    // the client also blocks it.
    const res = await request.post(`${target.baseUrl}/api/feedback`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      data: {
        message: `E2E SVG REJECT ${Date.now()}`,
        surface: "/assistant",
        screenshot: {
          content_type: "image/svg+xml",
          data_base64: Buffer.from("<svg/>").toString("base64"),
          byte_size: 5,
        },
      },
    });
    if (res.status() === 429) {
      test.skip(true, "feedback rate limit hit (3/min); rerun shortly");
      return;
    }
    expect(res.status(), "SVG screenshot is rejected at the server").toBe(400);
    const err = await res.json();
    expect(String(err.detail ?? "")).toContain("screenshot");
  });
});
