/**
 * Authenticated post-deploy device sweep.
 *
 * The gap this closes: the standalone `verify:devices` tool and the stub-based
 * matrix can only reach public or stubbable pages. The dense UI lives behind
 * auth (/admin/*), and a stub session gets bounced to /login. This spec signs in
 * with the real smoke account and runs the SAME layout assessment
 * (`measureLayoutDom` + `assessLayout`) across phone/tablet/desktop on the
 * authenticated pages, so responsive breaks on the admin surfaces are caught
 * automatically after deploy instead of reaching the operator.
 *
 * Runs against PROD_URL post-deploy (CI). Skips gracefully (not fails) when the
 * smoke creds are absent, exactly like smoke.spec.
 *
 * Scope: this catches the layout classes `assessLayout` detects, horizontal
 * overflow, elements past the viewport edge, and missing/zero-size must-be-visible
 * content. It does NOT catch "cramped but not overflowing" or "content buried
 * below the fold"; those remain a visual-review concern.
 */
import { test, expect } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible } from "./helpers/smoke-helpers";
import { waitForAppReady } from "./helpers/app-ready";
import {
  DEVICES,
  assessLayout,
  measureLayoutDom,
  type LayoutObservation,
} from "@/lib/platform-scan/browser/device-matrix";

const target = resolveSmokeTarget();

// Authenticated pages to sweep. `mustBeVisible` is set only where a stable
// selector is known, so a blank/redirected render is flagged without risking a
// false positive on pages whose markup we have not pinned.
const PAGES: { path: string; mustBeVisible: string[] }[] = [
  { path: "/admin/agents", mustBeVisible: ['[data-testid="agents-fleet-metrics"]'] },
  { path: "/admin/deployment", mustBeVisible: [] },
  { path: "/admin/site-analytics", mustBeVisible: ['[data-testid="top-pages"]'] },
  { path: "/engineering", mustBeVisible: ['[data-testid="wiki-content"]'] },
  { path: "/products", mustBeVisible: [] },
  { path: "/releases", mustBeVisible: [] },
];

test.describe("authenticated device sweep", () => {
  test.beforeAll(async () => {
    await waitForAppReady(target.baseUrl);
  });

  test("no high-severity layout issues across devices on authenticated pages", async ({ page }) => {
    if (!target.email || !target.password) {
      test.skip(true, "SMOKE_TEST_EMAIL / SMOKE_TEST_PASSWORD not set; skipping authenticated device sweep.");
      return;
    }

    const signedIn = await signInIfPossible(page, target);
    expect(signedIn, "sign-in was attempted").toBe(true);

    const issues: string[] = [];
    for (const device of DEVICES) {
      await page.setViewportSize({ width: device.width, height: device.height });
      for (const p of PAGES) {
        await page.goto(new URL(p.path, target.baseUrl).toString(), { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.waitForTimeout(600);

        const dom = await measureLayoutDom(
          page,
          p.mustBeVisible.map((selector) => ({ selector, mustBeVisible: true })),
        );
        const obs: LayoutObservation = {
          device: device.name,
          viewportWidth: device.width,
          viewportHeight: device.height,
          documentScrollWidth: dom.documentScrollWidth,
          innerWidth: dom.innerWidth,
          probed: dom.probed,
          clipped: dom.clipped,
          overlaps: dom.overlaps,
          contentTopPx: dom.contentTopPx,
          // Layout-only sweep: console/CSP/network noise is left to the smoke test,
          // so a real page's benign 401s do not drown the layout signal.
          consoleErrors: [],
          cspViolations: [],
          failedRequests: [],
        };
        for (const f of assessLayout(obs).filter((x) => x.severity === "high")) {
          issues.push(`${p.path} @ ${device.name} (${device.width}px): ${f.title} — ${f.detail}`);
        }
      }
    }

    if (issues.length > 0) {
      console.log(`[device-sweep] ${issues.length} high-severity issue(s):\n${issues.join("\n")}`);
    }
    expect(
      issues,
      `high-severity responsive/layout issues on authenticated pages:\n${issues.join("\n")}`,
    ).toEqual([]);
  });
});
