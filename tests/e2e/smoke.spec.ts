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
  resolveSmokeTarget,
  signInIfPossible,
  type SmokeProbe,
} from "./helpers/smoke-helpers";
import { waitForAppReady } from "./helpers/app-ready";

const target = resolveSmokeTarget();

// Routes per the verify spec. Authenticated routes expect text found in the
// signed-in dashboard shell; the landing route works unauthenticated.
const PROBES: SmokeProbe[] = [
  { path: "/", expectText: "Instinct" },
  { path: "/setup", expectText: "Setup" },
  { path: "/tasks", expectText: "Task" },
  { path: "/notifications", expectText: "Notification" },
  { path: "/settings", expectText: "Setting" },
  { path: "/admin/audit", expectText: "Audit" },
  { path: "/security-posture", expectText: "Security" },
];

// Routes that only work pre-auth (login itself). Keep the landing / root probe
// above — it is expected to render without a session.
const PUBLIC_PATHS = new Set<string>(["/"]);

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

    for (const probe of PROBES) {
      await probePath(page, target, probe);
    }
  });

  test("public landing renders without CSP violations", async ({ page }) => {
    await probePath(page, target, { path: "/", expectText: "Instinct" });
  });
});
