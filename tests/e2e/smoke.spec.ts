/**
 * Instinct (wolfpack-apex) E2E smoke test.
 *
 * Runs against PROD_URL if set, otherwise http://localhost:3000. Skips
 * gracefully (not fails) if SMOKE_TEST_EMAIL/PASSWORD are absent and the
 * target routes require auth.
 *
 * Asserts per-route:
 *   - HTTP 200 on page load
 *   - Zero CSP violations in console during load + 3s idle
 *   - Zero 401/403/5xx XHR/fetch responses
 *   - At least one known-visible text fragment (page is not blank)
 */
import { test, expect } from "@playwright/test";
import {
  probePath,
  hasInstinctToken,
  resolveSmokeTarget,
  signInIfPossible,
} from "./helpers/smoke-helpers";
import { PROBES, PUBLIC_PATHS, PUBLIC_LANDING_PROBE } from "./helpers/smoke-probes";
import { waitForAppReady } from "./helpers/app-ready";

const target = resolveSmokeTarget();


test.describe("verify smoke", () => {
  test.beforeAll(async () => {
    if (!target.isProduction) {
      // Local fallback is fine, just surface it.
      console.log(`[smoke] PROD_URL not set; using ${target.baseUrl}`);
    }
    // Wait for the target to actually be up before probing. A cold preview
    // returns 502/503 for the first few seconds; without this gate the first
    // probe races the boot and fails on readiness, not on a real bug. This
    // does NOT change what any probe asserts.
    await waitForAppReady(target.baseUrl);
  });

  test("authenticated routes render cleanly", async ({ page }) => {
    // If auth creds are missing AND any probe is auth-gated, skip gracefully.
    const needsAuth = PROBES.some((p) => !PUBLIC_PATHS.has(p.path));
    if (needsAuth && (!target.email || !target.password)) {
      test.skip(
        true,
        "SMOKE_TEST_EMAIL / SMOKE_TEST_PASSWORD not set; skipping authenticated smoke. " +
          "Set both env vars to enable.",
      );
      return;
    }

    // Sign in once, then probe every route on the same page.
    const signedIn = await signInIfPossible(page, target);
    expect(signedIn, "sign-in was attempted").toBe(true);
    // signInIfPossible returns true for "the form was filled in", which is not
    // the same claim as "there is a session". Its own doc comment says so. If
    // the smoke credentials ever go stale, every probe below would be testing
    // the login page, and the ones expecting shell text would fail for a reason
    // that has nothing to do with the route named in the error.
    expect(
      await hasInstinctToken(page),
      "sign-in produced a real session (check SMOKE_TEST_EMAIL / SMOKE_TEST_PASSWORD)",
    ).toBe(true);

    for (const probe of PROBES) {
      await probePath(page, target, probe);
    }
  });

  test("public landing renders without CSP violations", async ({ page }) => {
    // Signed out, / resolves to the sign-in screen. "Sign In" is content only a
    // rendered page has; "Instinct" was not, because the splash says it too.
    await probePath(page, target, PUBLIC_LANDING_PROBE);
  });
});
