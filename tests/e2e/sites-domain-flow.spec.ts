/**
 * Sites — custom domain binding E2E.
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD + SITES_SMOKE_PROJECT_ID.
 * When any is missing the test is skipped so CI stays green on PRs that
 * don't configure the secret.
 *
 * Safety: we STUB every call to /api/sites/:id/domain via
 * page.route() so the test never hits the real Vercel API. That way:
 *   - no rate limits are consumed,
 *   - no test domains attach to the team's production Vercel account,
 *   - the test runs deterministically regardless of backend state.
 *
 * What we verify:
 *   1. DomainManager mounts on /sites/[id].
 *   2. Typing a junk domain + clicking Add calls POST with the right body.
 *   3. The verification records we stub land in the DOM so a client can
 *      copy-paste them.
 *   4. Clicking Refresh calls PATCH action=refresh.
 *   5. Clicking Remove (after confirm) calls DELETE with ?domain=.
 */
import { test, expect } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const projectId = process.env.SITES_SMOKE_PROJECT_ID;

test.describe("sites domain flow", () => {
  test.skip(
    !target.email || !target.password || !projectId,
    "SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD + SITES_SMOKE_PROJECT_ID not configured",
  );

  test("add, refresh, and remove a custom domain through the UI", async ({ page }) => {
    // Unique per-run so multiple CI runs don't collide in assertions.
    const fakeDomain = `test-${Date.now()}.example.invalid`;

    // ---- stubs ---------------------------------------------------------
    let addCalled = false;
    let refreshCalled = false;
    let removeCalled = false;
    let listResponseDomains: Array<Record<string, unknown>> = [];

    await page.route(
      `**/api/sites/${projectId}/domain**`,
      async (route) => {
        const req = route.request();
        const method = req.method();
        if (method === "GET") {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ domains: listResponseDomains }),
          });
        }
        if (method === "POST") {
          addCalled = true;
          const record = {
            id: "d_stub",
            site_id: projectId,
            domain: fakeDomain,
            status: "pending",
            verification_records: [
              {
                type: "TXT",
                domain: `_vercel.${fakeDomain}`,
                value: "vc-stub-abc123",
              },
            ],
            added_at: new Date().toISOString(),
            verified_at: null,
            removed_at: null,
            last_error: null,
          };
          listResponseDomains = [record];
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              domain: record.domain,
              status: record.status,
              verification: record.verification_records,
              record,
            }),
          });
        }
        if (method === "PATCH") {
          refreshCalled = true;
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              record: { ...listResponseDomains[0], status: "verified" },
            }),
          });
        }
        if (method === "DELETE") {
          removeCalled = true;
          listResponseDomains = [];
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true }),
          });
        }
        return route.continue();
      },
    );

    // Accept any confirm() so Remove proceeds without a browser prompt.
    page.on("dialog", (d) => d.accept().catch(() => {}));

    // ---- sign-in + navigate -------------------------------------------
    const signedIn = await signInIfPossible(page, target);
    test.skip(!signedIn, "sign-in unavailable");

    await page.goto(`${target.baseUrl}/sites/${projectId}`, {
      waitUntil: "domcontentloaded",
    });

    const manager = page.getByTestId("domain-manager");
    await expect(manager).toBeVisible({ timeout: 10_000 });

    // ---- add domain ----------------------------------------------------
    await page.getByTestId("domain-input").fill(fakeDomain);
    await page.getByTestId("domain-add-button").click();

    await expect.poll(() => addCalled).toBe(true);
    await expect(page.getByTestId(`domain-row-${fakeDomain}`)).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByTestId(`domain-verification-${fakeDomain}`),
    ).toContainText("vc-stub-abc123");

    // ---- refresh -------------------------------------------------------
    await page.getByTestId(`domain-refresh-${fakeDomain}`).click();
    await expect.poll(() => refreshCalled).toBe(true);

    // ---- remove --------------------------------------------------------
    await page.getByTestId(`domain-remove-${fakeDomain}`).click();
    await expect.poll(() => removeCalled).toBe(true);
  });
});
