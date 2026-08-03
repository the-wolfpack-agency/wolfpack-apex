/**
 * /hr roster + access control E2E.
 *
 * The reported bug: /hr listed only the employee records somebody typed in by
 * hand, so a teammate who accepted an invite had access and appeared nowhere.
 * There was no way to see who could sign in, and no way to remove access or
 * give it back. `is_active` was read on every authenticated path and written by
 * nothing.
 *
 * A unit test cannot catch that class of failure, because the old page was
 * internally consistent: it correctly rendered the wrong list. This drives the
 * real UI against a real database and asserts what a person would look for.
 *
 * Two parts:
 *   - Always (given sign-in): the roster loads, returns 200, and shows the
 *     signed-in user with a legible access state. No CSP violations.
 *   - Gated on ROSTER_SMOKE_TARGET_EMAIL: removing and restoring that account's
 *     access actually round-trips. Point it at a disposable account you control,
 *     never at a real teammate, since the middle of this test leaves them
 *     unable to sign in.
 */
import { test, expect, type Page } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const revokeTargetEmail = process.env.ROSTER_SMOKE_TARGET_EMAIL;

/** Collects CSP violations, which render as a blank or half-dead page. */
function watchCsp(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (/Content Security Policy|Refused to (load|execute|connect)/i.test(text)) {
      violations.push(text);
    }
  });
  return violations;
}

async function openRoster(page: Page) {
  const rosterResponse = page.waitForResponse(
    (res) => res.url().includes("/api/people/roster") && res.request().method() === "GET",
  );
  await page.goto(`${target.baseUrl}/hr`, { waitUntil: "domcontentloaded" });
  const employeesTab = page.getByRole("button", { name: /employees/i }).first();
  if (await employeesTab.isVisible().catch(() => false)) {
    await employeesTab.click();
  }
  return rosterResponse;
}

test.describe("/hr roster", () => {
  test.skip(!target.email || !target.password, "SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD not configured");

  test("shows everyone with access, not only typed-in employee records", async ({ page }) => {
    const csp = watchCsp(page);
    expect(await signInIfPossible(page, target)).toBe(true);

    const response = await openRoster(page);
    // 200, not merely "not a 500". A 401 here is the blank-page failure mode.
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(Array.isArray(body.roster)).toBe(true);

    /* The signed-in account necessarily has access, so it must appear. If the
       roster were still reading employees only, this is the assertion that
       fails: an account with no HR record would be missing entirely. */
    const self = body.roster.find(
      (r: { email: string | null }) => r.email?.toLowerCase() === target.email!.toLowerCase(),
    );
    expect(self, `signed-in account ${target.email} missing from the roster`).toBeTruthy();
    expect(self.access).toBe("active");
    expect(self.member_id).toBeTruthy();

    // The list renders real rows rather than an empty state or a spinner.
    await expect(page.getByTestId("employee-editor-list")).toBeVisible();
    await expect(page.getByTestId(`roster-row-${self.key}`)).toBeVisible();
    await expect(page.getByTestId(`roster-access-${self.key}`)).toHaveText("Has access");
    await expect(page.getByTestId("roster-load-error")).toHaveCount(0);

    expect(csp, `CSP violations: ${csp.join(" | ")}`).toHaveLength(0);
  });

  test("never offers a control that would lock the signed-in user out", async ({ page }) => {
    // Removing your own access locks you out of the surface that would undo it,
    // and if you are the last administrator it locks everyone out. The API
    // refuses it; the UI should not offer it either.
    expect(await signInIfPossible(page, target)).toBe(true);
    const response = await openRoster(page);
    expect(response.status()).toBe(200);
    const body = await response.json();
    const self = body.roster.find(
      (r: { email: string | null }) => r.email?.toLowerCase() === target.email!.toLowerCase(),
    );
    expect(self).toBeTruthy();

    page.on("dialog", (d) => d.accept());
    const ownRevoke = page.getByTestId(`access-revoke-btn-${self.member_id}`);
    if (await ownRevoke.isVisible().catch(() => false)) {
      const refusal = page.waitForResponse((res) =>
        res.url().includes(`/api/people/roster/${self.member_id}/access`),
      );
      await ownRevoke.click();
      expect((await refusal).status()).toBe(400);
      // And the user is still signed in and still has access.
      await expect(page.getByTestId("roster-access-error")).toBeVisible();
      await page.reload({ waitUntil: "domcontentloaded" });
      expect(new URL(page.url()).pathname).not.toBe("/login");
    }
  });
});

test.describe("/hr access removal and restore", () => {
  test.skip(
    !target.email || !target.password || !revokeTargetEmail,
    "SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD + ROSTER_SMOKE_TARGET_EMAIL not configured",
  );

  test("access round-trips: removed, then restored", async ({ page }) => {
    expect(await signInIfPossible(page, target)).toBe(true);
    page.on("dialog", (d) => d.accept());

    const first = await openRoster(page);
    expect(first.status()).toBe(200);
    const body = await first.json();
    const subject = body.roster.find(
      (r: { email: string | null }) => r.email?.toLowerCase() === revokeTargetEmail!.toLowerCase(),
    );
    expect(subject, `${revokeTargetEmail} is not on the roster`).toBeTruthy();
    expect(subject.member_id, `${revokeTargetEmail} has no account to revoke`).toBeTruthy();
    expect(body.can_manage_access).toBe(true);

    const wasActive = subject.access === "active";

    if (wasActive) {
      const revoked = page.waitForResponse((res) =>
        res.url().includes(`/api/people/roster/${subject.member_id}/access`),
      );
      await page.getByTestId(`access-revoke-btn-${subject.member_id}`).click();
      expect((await revoked).status()).toBe(200);
      // The row stays visible and reports the new state. Vanishing would read
      // as "never existed" and leave nothing to restore.
      await expect(page.getByTestId(`roster-access-${subject.key}`)).toHaveText("Access removed", {
        timeout: 10_000,
      });
    }

    const restored = page.waitForResponse((res) =>
      res.url().includes(`/api/people/roster/${subject.member_id}/access`),
    );
    await page.getByTestId(`access-restore-btn-${subject.member_id}`).click();
    expect((await restored).status()).toBe(200);
    await expect(page.getByTestId(`roster-access-${subject.key}`)).toHaveText("Has access", {
      timeout: 10_000,
    });

    // Survives a reload, so it was persisted rather than only re-rendered.
    const reloaded = await openRoster(page);
    expect(reloaded.status()).toBe(200);
    const after = (await reloaded.json()).roster.find(
      (r: { member_id: string | null }) => r.member_id === subject.member_id,
    );
    expect(after.access).toBe("active");
  });
});
