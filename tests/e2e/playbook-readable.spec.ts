/**
 * The playbook is readable in a real browser, against the deployed URL.
 *
 * It shipped correct and unreadable: headings at body weight, table cells run
 * together, both architecture diagrams collapsed into prose. Fifty unit tests
 * passed throughout, because every one of them read the source string and none
 * looked at what a person gets.
 *
 * So this asserts COMPUTED STYLE and rendered node counts, which is the only
 * form of this check that could have caught the original bug. A class being
 * present in the markup proved nothing: the class was there the whole time and
 * the stylesheet it named did not exist.
 */
import { test, expect } from "@playwright/test";
import { resolveSmokeTarget, stubInstinctSession } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("the client deployment playbook", () => {
  test.beforeEach(async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
  });

  test("renders as a formatted document, not a wall of text", async ({ page }) => {
    await page.goto(`${target.baseUrl}/playbook`, { waitUntil: "domcontentloaded" });
    const root = page.getByTestId("client-deployment-playbook");
    await expect(root).toBeVisible({ timeout: 30_000 });

    const body = page.locator(".wp-playbook-body");

    /* The diagrams. Indented blocks are not code blocks to this renderer, so
       ASCII art written that way silently becomes a paragraph. */
    await expect(body.locator("pre")).toHaveCount(2);
    await expect(body.locator("pre").first()).toContainText("the gate");

    /* The tables that rendered as "Microsoft 365 tenant consentTheir IT". */
    const tables = body.locator("table");
    expect(await tables.count()).toBeGreaterThanOrEqual(5);

    /* A heading has to LOOK like a heading. This is the assertion that fails
       when the stylesheet is missing while the markup is perfect. */
    const h2 = body.locator("h2").first();
    const size = await h2.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const weight = await h2.evaluate((el) => getComputedStyle(el).fontWeight);
    expect(size).toBeGreaterThan(17);
    expect(Number(weight)).toBeGreaterThanOrEqual(700);

    /* A table cell needs separation, which is literally what ran together. */
    const th = body.locator("th").first();
    const pad = await th.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
    const border = await th.evaluate((el) => parseFloat(getComputedStyle(el).borderTopWidth));
    expect(pad).toBeGreaterThan(0);
    expect(border).toBeGreaterThan(0);

    /* Tailwind Preflight strips list markers globally; without the fix every
       list reads as prose. */
    const marker = await body
      .locator("ul li")
      .first()
      .evaluate((el) => getComputedStyle(el.parentElement as Element).listStyleType);
    expect(marker).not.toBe("none");
  });

  test("carries a contents rail that reaches every section", async ({ page }) => {
    await page.goto(`${target.baseUrl}/playbook`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("client-deployment-playbook")).toBeVisible({ timeout: 30_000 });

    const links = page.locator(".wp-playbook-toc a");
    const anchors = page.locator(".wp-playbook-body h2[id]");
    const linkCount = await links.count();
    expect(linkCount).toBeGreaterThan(5);
    /* Every entry points at a heading that exists. A contents list with a dead
       link is the same failure as the nav telling people to look in the rail. */
    expect(await anchors.count()).toBe(linkCount);
    for (let i = 0; i < linkCount; i++) {
      const href = await links.nth(i).getAttribute("href");
      await expect(page.locator(`${href}`)).toHaveCount(1);
    }
  });

  /* The page body must never scroll sideways: that is what a squeezed table
     does before it starts stacking one letter per line. */
  test("does not scroll sideways", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${target.baseUrl}/playbook`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("client-deployment-playbook")).toBeVisible({ timeout: 30_000 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
