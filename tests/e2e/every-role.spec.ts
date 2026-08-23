/**
 * E2E: does the product work for somebody who is not an admin?
 *
 * WHY THIS EXISTS
 *
 * The first non-admin test account found a bug within a minute of existing: the
 * dashboard asked an admin-only endpoint on every load, for everybody, and got
 * a 403 for most of the workspace. Nothing looked broken, because the component
 * degraded correctly, which is exactly why it survived for months.
 *
 * That bug was invisible to every test we had, because every test we had ran as
 * an admin or as a stub. Most people in a workspace are not admins. A page that
 * misbehaves for an ordinary employee misbehaves for almost everybody.
 *
 * So this walks the pages a normal person uses, once per role, and asserts the
 * things that are true regardless of role:
 *
 *   - the page returns 200 and renders something
 *   - it does not fire a request it is not allowed to make
 *   - no Content Security Policy violations
 *
 * WHAT IT DOES NOT ASSERT is that every role sees the same content. A designer
 * seeing fewer panels than an ops lead is the gate working. The failure being
 * hunted is a page ASKING for what this person cannot have, or rendering
 * nothing at all.
 *
 * Skips cleanly without credentials, so a fork or a local run does not fail on
 * a secret it was never going to have.
 */
import { test, expect, type Page } from "@playwright/test";
import { resolveSmokeTarget } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

/** Mirrors TEST_ROLES in scripts/provision-e2e-account.ts. */
const ROLES = ["designer", "sales", "ops", "hr", "dev"] as const;

/** Pages a person in any of these roles would open in an ordinary week. */
const PAGES = [
  { path: "/", name: "dashboard" },
  { path: "/assistant", name: "assistant" },
  { path: "/routines", name: "routines" },
  { path: "/releases", name: "releases" },
  { path: "/engineering", name: "engineering" },
  { path: "/notifications", name: "notifications" },
  { path: "/settings", name: "settings" },
];

function emailForRole(role: string): string {
  return role === "designer" ? "e2e@thewolfpack.agency" : `e2e-${role}@thewolfpack.agency`;
}

const password = process.env.ADMIN_E2E_PASSWORD ?? process.env.SMOKE_TEST_PASSWORD;

async function signIn(page: Page, role: string): Promise<void> {
  await page.goto(`${target.baseUrl}/login`, { waitUntil: "domcontentloaded" });
  const email = page.locator('input[name="email"], input[type="email"]').first();
  await email.waitFor({ state: "visible", timeout: 20_000 });
  await email.fill(emailForRole(role));
  await page.locator('input[name="password"], input[type="password"]').first().fill(password!);
  /* Enabled only once hydrated: a click before then does a native GET submit
     and no POST ever happens, which is the flaky-login failure this repo has
     already been bitten by. */
  const submit = page.locator('button[type="submit"]').first();
  await expect(submit).toBeEnabled({ timeout: 20_000 });
  await submit.click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
}

test.describe("every role can use the product", () => {
  test.skip(!password, "needs ADMIN_E2E_PASSWORD; the role accounts share one");

  for (const role of ROLES) {
    test(`${role}: no page asks for what it cannot have`, async ({ page }) => {
      /* 403 IS THE SIGNAL. 401 IS NOT, and getting that wrong nearly turned a
         working feature into a bug report.
       *
       * A 403 means the server refused on capability: the page asked for
       * something this person may not have, and no retry will change that.
       * That is the failure being hunted, because the component degrades
       * quietly and the only trace is a log full of refusals nobody reads.
       *
       * A 401 is routinely the token-refresh handshake. Access tokens last
       * fifteen minutes, so fetchWithRefresh expects a 401, refreshes, and
       * retries; the first attempt appears in the network log of a page that
       * is working exactly as designed. Counting it would fail every role on
       * every run and teach us to delete the assertion.
       *
       * So a 401 counts only when NOTHING to that path afterwards succeeded,
       * which is the case where the refresh did not save it. */
      const refused: string[] = [];
      const unauthorized = new Map<string, number>();
      const succeeded = new Set<string>();
      const csp: string[] = [];

      page.on("response", (res) => {
        const status = res.status();
        const path = new URL(res.url()).pathname;
        if (!path.startsWith("/api/")) return;
        if (status === 403) {
          refused.push(`403 ${res.request().method()} ${path}`);
        } else if (status === 401) {
          unauthorized.set(path, (unauthorized.get(path) ?? 0) + 1);
        } else if (status >= 200 && status < 300) {
          succeeded.add(path);
        }
      });
      page.on("console", (m) => {
        if (m.type() === "error" && /Content Security Policy/i.test(m.text())) csp.push(m.text());
      });

      await signIn(page, role);

      for (const p of PAGES) {
        const res = await page.goto(`${target.baseUrl}${p.path}`, { waitUntil: "domcontentloaded" });
        expect(res?.status(), `${role} got a non-200 on ${p.path}`).toBe(200);

        /* Rendered SOMETHING. A signed-in page with an empty body is the
           blank-dashboard failure, and it returns 200 while doing it. */
        await page.waitForTimeout(1200);
        const text = (await page.locator("body").innerText()).trim();
        expect(text.length, `${role} saw a blank ${p.path}`).toBeGreaterThan(40);
      }

      /* A 401 that never recovered: the refresh did not save it, so the page
         genuinely could not read what it asked for. */
      const neverRecovered = [...unauthorized.keys()].filter((p) => !succeeded.has(p));

      expect(refused, `${role} asked for something its role cannot have`).toEqual([]);
      expect(neverRecovered, `${role} hit a 401 that no refresh recovered`).toEqual([]);
      expect(csp, `${role} hit CSP violations`).toEqual([]);
    });
  }
});
