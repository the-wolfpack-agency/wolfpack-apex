/**
 * Sites — theme editor + new section types + admin hard-delete E2E.
 *
 * Proves the 2026-04-18 feature set functions end-to-end through the UI:
 *   1. Sign-in → POST /api/sites creates a throwaway site
 *   2. Detail page renders the ThemeEditor with 5 color rows + font select
 *   3. Theme color edit round-trips through save + reload (no clobber)
 *   4. BriefForm exposes + appends testimonial / pricing / faq sections
 *   5. Section edits round-trip through save + reload
 *   6. Admin-only "Delete permanently" hard-deletes + redirects to /sites
 *
 * Does NOT trigger a deploy — that requires Instinct env vars the user
 * hasn't set yet, and preflight (commit 8b7ad91) correctly blocks us.
 * The deploy-triggered flow is covered separately by sites-edit-flow.spec.ts.
 *
 * Skipped when SMOKE_TEST_EMAIL / SMOKE_TEST_PASSWORD aren't set — the
 * nightly canary (which has creds) is the loud-failure surface.
 */
import { test, expect, type Page } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

interface CreateSiteResponse {
  project: { id: string; client_slug: string; display_name: string };
}

async function authToken(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      localStorage.getItem("instinct_token") ??
      localStorage.getItem("apex_token") ??
      "",
  );
}

async function createThrowawaySite(page: Page): Promise<{ id: string; slug: string }> {
  const slug = `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const token = await authToken(page);
  const r = await page.request.post(`${target.baseUrl}/api/sites`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: {
      brief: {
        client: slug,
        product: { name: `E2E ${slug}`, supportEmail: "e2e@wolfpack.test" },
        pages: [
          {
            route: "/",
            title: "Home",
            sections: [{ type: "hero", heading: "E2E baseline" }],
          },
        ],
      },
    },
  });
  expect(r.status(), await r.text()).toBe(200);
  const data = (await r.json()) as CreateSiteResponse;
  return { id: data.project.id, slug };
}

async function currentRole(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const raw =
      localStorage.getItem("instinct_user") ?? localStorage.getItem("apex_user");
    if (!raw) return null;
    try {
      return (JSON.parse(raw) as { role?: string }).role ?? null;
    } catch {
      return null;
    }
  });
}

async function readBriefFromApi(page: Page, id: string): Promise<Record<string, unknown>> {
  const token = await authToken(page);
  const r = await page.request.get(`${target.baseUrl}/api/sites/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(r.status()).toBe(200);
  const data = (await r.json()) as { project: { brief: Record<string, unknown> } };
  return data.project.brief;
}

test.describe("sites — theme + sections + hard-delete", () => {
  test.skip(
    !target.email || !target.password,
    "SMOKE_TEST_EMAIL/PASSWORD not set — skipping E2E",
  );

  test("theme editor renders all 5 color rows + the font dropdown", async ({ page }) => {
    expect(await signInIfPossible(page, target)).toBe(true);
    const { id } = await createThrowawaySite(page);
    await page.goto(`${target.baseUrl}/sites/${id}`, { waitUntil: "networkidle" });

    // Every theme color row must be mounted + labeled. Missing rows mean
    // the ThemeEditor didn't render at all.
    await expect(page.getByLabel(/Primary brand hex value/i)).toBeVisible();
    await expect(page.getByLabel(/Accent hex value/i)).toBeVisible();
    await expect(page.getByLabel(/Background hex value/i)).toBeVisible();
    await expect(page.getByLabel(/Foreground text hex value/i)).toBeVisible();
    await expect(page.getByLabel(/Muted .* hex value/i)).toBeVisible();

    // Font selector is a real <select> and names the "Font family" label.
    const fontSelect = page.getByLabel(/Font family/i);
    await expect(fontSelect).toBeVisible();
    // At least the 12 curated families are in the option list.
    const optionCount = await fontSelect.locator("option").count();
    expect(optionCount).toBeGreaterThanOrEqual(12);

    // Cleanup
    await page.request.delete(`${target.baseUrl}/api/sites/${id}?hard=true`, {
      headers: { Authorization: `Bearer ${await authToken(page)}` },
    });
  });

  test("theme primary color change round-trips through save + reload", async ({ page }) => {
    expect(await signInIfPossible(page, target)).toBe(true);
    const { id } = await createThrowawaySite(page);
    await page.goto(`${target.baseUrl}/sites/${id}`, { waitUntil: "networkidle" });

    const hexInput = page.getByLabel(/Primary brand hex value/i);
    await expect(hexInput).toBeVisible();
    await hexInput.fill("#ff6600");
    // ThemeEditor propagates onChange synchronously after a valid hex.
    // Save uses the detail page's "Save brief" button.
    await page.getByRole("button", { name: /Save brief/i }).click();
    await expect(page.getByText(/Brief saved/i)).toBeVisible({ timeout: 10_000 });

    // Read the persisted brief directly — the UI swaps a <input defaultValue>
    // on reload which is harder to assert reliably than the API round-trip.
    await page.reload({ waitUntil: "networkidle" });
    const brief = await readBriefFromApi(page, id);
    const theme = brief.theme as { colors?: { primary?: string } } | undefined;
    expect(theme?.colors?.primary).toBe("#ff6600");

    await page.request.delete(`${target.baseUrl}/api/sites/${id}?hard=true`, {
      headers: { Authorization: `Bearer ${await authToken(page)}` },
    });
  });

  test("adding testimonial + pricing + faq sections round-trips", async ({ page }) => {
    expect(await signInIfPossible(page, target)).toBe(true);
    const { id } = await createThrowawaySite(page);
    await page.goto(`${target.baseUrl}/sites/${id}`, { waitUntil: "networkidle" });

    // Click the three new "+ {type}" buttons BriefForm renders.
    await page.getByRole("button", { name: /^\+ testimonial$/ }).click();
    await page.getByRole("button", { name: /^\+ pricing$/ }).click();
    await page.getByRole("button", { name: /^\+ faq$/ }).click();

    // Fill at least one field of each so persistence is unambiguous.
    await page.getByLabel(/Testimonial 1 quote/i).fill("E2E quote");
    await page.getByLabel(/Testimonial 1 author name/i).fill("E2E Author");
    await page.getByLabel(/Pricing tier 1 name/i).fill("E2E Plan");
    await page.getByLabel(/Pricing tier 1 price/i).fill("$99/mo");
    await page.getByLabel(/FAQ 1 question/i).fill("E2E question?");
    await page.getByLabel(/FAQ 1 answer/i).fill("E2E answer.");

    await page.getByRole("button", { name: /Save brief/i }).click();
    await expect(page.getByText(/Brief saved/i)).toBeVisible({ timeout: 10_000 });

    // Round-trip via API — structural assertion survives UI reshuffling.
    const brief = await readBriefFromApi(page, id);
    const pages = brief.pages as Array<{ sections: Array<{ type: string }> }>;
    const sectionTypes = pages.flatMap((p) => p.sections.map((s) => s.type));
    expect(sectionTypes).toEqual(
      expect.arrayContaining(["testimonial", "pricing", "faq"]),
    );

    await page.request.delete(`${target.baseUrl}/api/sites/${id}?hard=true`, {
      headers: { Authorization: `Bearer ${await authToken(page)}` },
    });
  });

  test("admin 'Delete permanently' redirects to /sites and removes the project", async ({ page }) => {
    expect(await signInIfPossible(page, target)).toBe(true);
    const role = await currentRole(page);
    test.skip(
      role === null || !["ceo", "cto", "hr"].includes(role),
      `signed-in role=${role} lacks hr+ access required for hard delete`,
    );

    const { id, slug } = await createThrowawaySite(page);
    await page.goto(`${target.baseUrl}/sites/${id}`, { waitUntil: "networkidle" });

    // Button gate: must render for admin roles only (server also enforces).
    const deleteBtn = page.getByRole("button", { name: /Delete permanently/i });
    await expect(deleteBtn).toBeVisible();

    // Auto-accept the window.confirm() dialog the handler raises.
    page.once("dialog", (d) => void d.accept());

    await deleteBtn.click();
    // Redirect to /sites — URL changes, list page loads.
    await page.waitForURL(new RegExp(`${target.baseUrl}/sites/?$`), { timeout: 10_000 });

    // The deleted slug must no longer be in the list (archived + scrubbed).
    // We allow cleanup result banner rendering slug, so assert the card is gone
    // via the list API instead of DOM scraping the flash message.
    const token = await authToken(page);
    const listRes = await page.request.get(`${target.baseUrl}/api/sites`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const listData = (await listRes.json()) as {
      projects: Array<{ id: string; client_slug: string }>;
    };
    const still = listData.projects.find((p) => p.id === id);
    expect(still, `deleted project ${slug} should not appear in list`).toBeUndefined();
  });
});
