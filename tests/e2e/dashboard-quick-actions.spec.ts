/**
 * /dashboard — personalized Quick Actions tile.
 *
 * Locks in PR #28:
 *   1. Card renders with EXACTLY 4 tiles (top-N from
 *      /api/insights/quick-actions, with a four-tile fallback so the
 *      card never looks broken on cold-start).
 *   2. Each tile has a non-empty label and a real `href`.
 *   3. Click navigates to the tile's href.
 *   4. Click fires the analytics POST `event: "dashboard.quick_action_clicked"`
 *      with `{ position, source }` in metadata.
 *
 * Testid shape: the parent card carries `quick-actions-card`; every
 * tile carries `quick-action-${position}` where `position` is the
 * 0-based index in the rendered list. This couples the analytics
 * `position` field (which is per-tile) to a DOM identifier the test
 * framework can verify.
 */
import { test, expect, type Request } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

async function settle(page: import("@playwright/test").Page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1500);
}

test.describe("dashboard quick actions (real browser)", () => {
  test.beforeEach(async ({ page }) => {
    if (!target.email || !target.password) {
      test.skip(true, "SMOKE_TEST_EMAIL / SMOKE_TEST_PASSWORD not set; skipping");
      return;
    }
    const signedIn = await signInIfPossible(page, target);
    expect(signedIn).toBe(true);
  });

  test("renders 4 tiles with labels, hrefs, and per-position testids", async ({ page }) => {
    const response = await page.goto(`${target.baseUrl}/dashboard`, {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);
    await settle(page);

    const card = page.getByTestId("quick-actions-card");
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Every tile must be addressable by its 0-based position.
    for (let i = 0; i < 4; i++) {
      const tile = page.getByTestId(`quick-action-${i}`);
      await expect(tile, `tile #${i} present`).toBeVisible({ timeout: 5_000 });

      const label = (await tile.innerText()).trim();
      expect(label.length, `tile #${i} label`).toBeGreaterThan(0);

      const href = await tile.getAttribute("data-href");
      expect(href, `tile #${i} data-href`).toBeTruthy();
      expect(href ?? "", `tile #${i} href is non-empty`).not.toEqual("");

      const position = await tile.getAttribute("data-position");
      expect(position, `tile #${i} data-position`).toBe(String(i));
    }

    // No 5th tile should exist — the card is capped at 4.
    await expect(page.getByTestId("quick-action-4")).toHaveCount(0);
  });

  test("clicking a tile fires analytics with position+source and navigates", async ({
    page,
  }) => {
    // Capture analytics requests BEFORE the click.
    const analyticsRequests: Request[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/analytics") && req.method() === "POST") {
        analyticsRequests.push(req);
      }
    });

    await page.goto(`${target.baseUrl}/dashboard`, { waitUntil: "domcontentloaded" });
    await settle(page);

    // Pick tile #2 to vary the position from the trivial #0.
    const POSITION = 2;
    const tile = page.getByTestId(`quick-action-${POSITION}`);
    await expect(tile).toBeVisible({ timeout: 5_000 });
    const expectedHref = await tile.getAttribute("data-href");
    expect(expectedHref).toBeTruthy();
    const expectedSource = await tile.getAttribute("data-source");
    expect(expectedSource).toBeTruthy();

    // Click — but intercept navigation, since the analytics POST is
    // fire-and-forget and we want to inspect it before the page swaps.
    await Promise.all([
      page.waitForURL(
        (url) => url.pathname.includes(expectedHref ?? "//does-not-exist"),
        { timeout: 10_000 },
      ),
      tile.click(),
    ]);

    // Allow analytics POSTs to flush.
    await page.waitForTimeout(500);

    // Find the click event among the captured POSTs.
    let matched: { position: number; source: string; href: string } | null = null;
    for (const req of analyticsRequests) {
      try {
        const body = req.postDataJSON() as {
          event?: string;
          metadata?: { position?: number; source?: string; href?: string };
        };
        if (body?.event === "dashboard.quick_action_clicked") {
          matched = {
            position: body.metadata?.position ?? -1,
            source: body.metadata?.source ?? "",
            href: body.metadata?.href ?? "",
          };
          break;
        }
      } catch {
        /* skip non-JSON */
      }
    }

    expect(
      matched,
      `analytics POST with event=dashboard.quick_action_clicked observed (saw ${analyticsRequests.length} analytics requests)`,
    ).not.toBeNull();
    expect(matched!.position).toBe(POSITION);
    expect(matched!.href).toBe(expectedHref);
    expect(matched!.source).toBe(expectedSource);
  });
});
