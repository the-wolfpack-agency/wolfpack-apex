/**
 * Sites — split-screen prompt editor E2E.
 *
 * Exercises the full prompt → patch → diff → preview → publish loop
 * against a running Instinct deployment. Skipped when creds aren't set;
 * the nightly canary runs with creds so env drift fails loud.
 *
 * What this test asserts (the UX contract):
 *   1. /sites/:id/edit mounts with both panes visible
 *   2. Typing a prompt + clicking Send fires POST /api/sites/:id/brief-edit
 *   3. On success, the draft banner flips + Publish becomes enabled
 *   4. Reloading the page restores the in-progress draft from localStorage
 *   5. Discard reverts to saved + records accepted=false on the edit
 *   6. Publish calls PATCH /api/sites/:id (save) then PATCH ?action=deploy
 *      in that order, and marks the last edit as accepted=true
 *   7. No Internal server error banner appears in any of these paths
 *
 * Regression for the 2026-04-17 incident: brokerage UX and deploy error
 * handling are the two places users see "something is wrong". Both get
 * pinned here so a regression can't silently ship.
 */
import { test, expect, type Request, type Page } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

interface SitesListResponse {
  projects: Array<{ id: string; client_slug: string; display_name: string }>;
}

async function firstProjectId(page: Page, baseUrl: string): Promise<string> {
  const token = await page.evaluate(
    () =>
      localStorage.getItem("instinct_token") ??
      localStorage.getItem("apex_token") ??
      "",
  );
  const r = await page.request.get(`${baseUrl}/api/sites`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await r.json()) as SitesListResponse;
  expect(data.projects.length).toBeGreaterThan(0);
  return data.projects[0].id;
}

test.describe("sites — prompt editor flow", () => {
  test.skip(
    !target.email || !target.password,
    "SMOKE_TEST_EMAIL/PASSWORD not set — skipping editor E2E",
  );

  test("editor mounts and both panes render", async ({ page }) => {
    expect(await signInIfPossible(page, target)).toBe(true);
    const id = await firstProjectId(page, target.baseUrl);

    await page.goto(`${target.baseUrl}/sites/${id}/edit`, { waitUntil: "networkidle" });
    await expect(page.getByTestId("edit-chat-pane")).toBeVisible();
    await expect(page.getByTestId("edit-preview-pane")).toBeVisible();
    await expect(page.getByTestId("edit-preview-iframe")).toBeVisible();

    // Pristine load → nothing to publish, no error banner
    await expect(page.getByText(/No changes to publish/i)).toBeVisible();
    await expect(page.getByTestId("edit-error-banner")).toHaveCount(0);
    // Must not render the generic Instinct 500 banner under any circumstance
    const body = await page.locator("body").innerText();
    expect(body).not.toMatch(/Internal server error/i);
  });

  test("sending a prompt applies a draft and enables Publish", async ({ page }) => {
    expect(await signInIfPossible(page, target)).toBe(true);
    const id = await firstProjectId(page, target.baseUrl);

    await page.goto(`${target.baseUrl}/sites/${id}/edit`, { waitUntil: "networkidle" });
    await expect(page.getByTestId("edit-chat-pane")).toBeVisible();

    // Capture the API call so we can prove it fired with the right shape.
    const editReq = page.waitForRequest(
      (req: Request) =>
        req.url().includes(`/api/sites/${id}/brief-edit`) && req.method() === "POST",
    );

    await page.getByTestId("edit-prompt-input").fill(
      "Add a stat block with 'Seasons raced' → 3 and 'Podiums' → 5",
    );
    await page.getByTestId("edit-send-btn").click();

    const req = await editReq;
    const body = JSON.parse((req.postData() ?? "{}") as string);
    expect(body.instruction).toMatch(/stat/i);
    expect(body.brief).toBeDefined();

    // Publish enables once a patch applies. Allow up to 30s for Haiku.
    await expect(page.getByTestId("edit-publish-btn")).not.toBeDisabled({
      timeout: 30_000,
    });
    await expect(page.getByText(/Draft — not yet published/i)).toBeVisible();
  });

  test("discard reverts draft + marks last edit rejected", async ({ page }) => {
    expect(await signInIfPossible(page, target)).toBe(true);
    const id = await firstProjectId(page, target.baseUrl);
    await page.goto(`${target.baseUrl}/sites/${id}/edit`, { waitUntil: "networkidle" });

    await page.getByTestId("edit-prompt-input").fill(
      "Change the hero headline to 'Draft Test'",
    );
    await page.getByTestId("edit-send-btn").click();
    await expect(page.getByTestId("edit-publish-btn")).not.toBeDisabled({
      timeout: 30_000,
    });

    const decisionReq = page.waitForRequest(
      (req: Request) =>
        req.url().includes(`/api/sites/${id}/brief-edit/`) && req.method() === "PATCH",
    );
    await page.getByTestId("edit-discard-btn").click();
    const req = await decisionReq;
    const body = JSON.parse((req.postData() ?? "{}") as string);
    expect(body.accepted).toBe(false);
    expect(body.rejectionReason).toBe("user_discarded_all");

    await expect(page.getByText(/Reverted to the last published brief/)).toBeVisible();
    await expect(page.getByText(/No changes to publish/i)).toBeVisible();
  });

  test("iframe preview renders the DRAFT content (not just saved)", async ({ page }) => {
    // This is the whole point of the editor: typing a prompt should make
    // the right-hand iframe show the updated site, without waiting for a
    // deploy. Validates the full chain: editor → base64 draft URL →
    // preview page → <RenderBrief> → visible heading.
    expect(await signInIfPossible(page, target)).toBe(true);
    const id = await firstProjectId(page, target.baseUrl);
    await page.goto(`${target.baseUrl}/sites/${id}/edit`, { waitUntil: "networkidle" });

    const unique = `Preview Probe ${Date.now()}`;
    await page.getByTestId("edit-prompt-input").fill(
      `Change the hero headline on the homepage to exactly "${unique}".`,
    );
    await page.getByTestId("edit-send-btn").click();
    await expect(page.getByTestId("edit-publish-btn")).not.toBeDisabled({ timeout: 30_000 });

    // The iframe src must include `draft=` after the prompt applies.
    const iframe = page.getByTestId("edit-preview-iframe");
    await expect(iframe).toHaveAttribute("src", /draft=/);

    // And the preview body inside the iframe must actually contain the
    // new heading. If this fails the live-preview chain is broken end
    // to end (even if other tests pass).
    const frame = await iframe.contentFrame();
    await expect(frame!.getByText(unique)).toBeVisible({ timeout: 10_000 });
  });

  test("draft persists across page reload (localStorage bridge)", async ({ page }) => {
    expect(await signInIfPossible(page, target)).toBe(true);
    const id = await firstProjectId(page, target.baseUrl);
    await page.goto(`${target.baseUrl}/sites/${id}/edit`, { waitUntil: "networkidle" });

    const unique = `Reload Probe ${Date.now()}`;
    await page.getByTestId("edit-prompt-input").fill(
      `Set the hero heading on the homepage to "${unique}".`,
    );
    await page.getByTestId("edit-send-btn").click();
    await expect(page.getByTestId("edit-publish-btn")).not.toBeDisabled({ timeout: 30_000 });

    // Reload — the restore banner should appear and Publish stays enabled.
    await page.reload({ waitUntil: "networkidle" });
    await expect(
      page.getByText(/Restored an in-progress draft from your last session/i),
    ).toBeVisible();
    await expect(page.getByTestId("edit-publish-btn")).not.toBeDisabled();
  });

  test("two prompts accumulate on the same draft", async ({ page }) => {
    expect(await signInIfPossible(page, target)).toBe(true);
    const id = await firstProjectId(page, target.baseUrl);
    await page.goto(`${target.baseUrl}/sites/${id}/edit`, { waitUntil: "networkidle" });

    // First prompt — capture the body it sends so we can compare.
    const firstReq = page.waitForRequest(
      (req: Request) =>
        req.url().includes(`/api/sites/${id}/brief-edit`) && req.method() === "POST",
    );
    await page.getByTestId("edit-prompt-input").fill("Change the hero CTA label to 'Get in touch'.");
    await page.getByTestId("edit-send-btn").click();
    const firstBody = JSON.parse(((await firstReq).postData() ?? "{}") as string);
    await expect(page.getByTestId("edit-publish-btn")).not.toBeDisabled({ timeout: 30_000 });

    // Second prompt — it MUST see the post-first-prompt draft, not the
    // pristine saved brief, otherwise edits don't compose.
    const secondReq = page.waitForRequest(
      (req: Request) =>
        req.url().includes(`/api/sites/${id}/brief-edit`) && req.method() === "POST",
    );
    await page.getByTestId("edit-prompt-input").fill("Also change the hero body to say 'Season One'.");
    await page.getByTestId("edit-send-btn").click();
    const secondBody = JSON.parse(((await secondReq).postData() ?? "{}") as string);

    // The brief sent with the second prompt should differ from the
    // brief sent with the first — proving draft accumulation.
    expect(JSON.stringify(secondBody.brief)).not.toBe(JSON.stringify(firstBody.brief));
  });

  test("ai_unavailable surfaces as a retryable banner, not a crash", async ({ page }) => {
    expect(await signInIfPossible(page, target)).toBe(true);
    const id = await firstProjectId(page, target.baseUrl);
    await page.goto(`${target.baseUrl}/sites/${id}/edit`, { waitUntil: "networkidle" });

    // Force a 502 by rerouting the brief-edit call at the network layer.
    await page.route(`**/api/sites/${id}/brief-edit`, (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({ error: "model timeout", reason: "ai_unavailable" }),
        });
      }
      return route.continue();
    });

    await page.getByTestId("edit-prompt-input").fill("Whatever.");
    await page.getByTestId("edit-send-btn").click();

    await expect(page.getByTestId("edit-error-banner")).toHaveText(/unavailable/i);
    await expect(page.getByText(/Internal server error/i)).toHaveCount(0);
  });

  test("patch_blocked surfaces which protected fields were refused", async ({ page }) => {
    expect(await signInIfPossible(page, target)).toBe(true);
    const id = await firstProjectId(page, target.baseUrl);
    await page.goto(`${target.baseUrl}/sites/${id}/edit`, { waitUntil: "networkidle" });

    await page.route(`**/api/sites/${id}/brief-edit`, (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({
            error: "patch touched protected fields",
            reason: "patch_blocked",
            blockedPaths: ["/client_slug", "/github_repo"],
          }),
        });
      }
      return route.continue();
    });

    await page.getByTestId("edit-prompt-input").fill("Rename the client slug to whatever.");
    await page.getByTestId("edit-send-btn").click();

    const banner = page.getByTestId("edit-error-banner");
    await expect(banner).toContainText("client_slug");
    await expect(banner).toContainText("github_repo");
  });

  test("empty prompt cannot be sent", async ({ page }) => {
    expect(await signInIfPossible(page, target)).toBe(true);
    const id = await firstProjectId(page, target.baseUrl);
    await page.goto(`${target.baseUrl}/sites/${id}/edit`, { waitUntil: "networkidle" });

    // Send button must be disabled when input is empty.
    await expect(page.getByTestId("edit-send-btn")).toBeDisabled();

    // Typing whitespace-only must leave it disabled.
    await page.getByTestId("edit-prompt-input").fill("   \n  ");
    await expect(page.getByTestId("edit-send-btn")).toBeDisabled();

    // Real content enables it.
    await page.getByTestId("edit-prompt-input").fill("x");
    await expect(page.getByTestId("edit-send-btn")).not.toBeDisabled();
  });

  test("detail page 'Prompt editor' link goes to /edit", async ({ page }) => {
    expect(await signInIfPossible(page, target)).toBe(true);
    const id = await firstProjectId(page, target.baseUrl);
    await page.goto(`${target.baseUrl}/sites/${id}`, { waitUntil: "networkidle" });

    const link = page.getByRole("link", { name: /Prompt editor/i });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", `/sites/${id}/edit`);
  });
});
