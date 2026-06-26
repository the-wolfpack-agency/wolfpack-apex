/**
 * Platform-scan BROWSER-journey runner.
 *
 * This is the browser layer of the platform-scan feature: it loads a TARGET
 * platform's pages in a real authenticated browser, captures the live signals
 * jest cannot reach (console errors, CSP violations, failed in-page API calls,
 * blank renders), classifies each page with the SAME pure classifyPage used by
 * unit tests, and POSTs the findings to the ingest endpoint, which persists into
 * the shared findings store.
 *
 * It is INERT in normal CI: the whole spec skips unless TARGET_BASE_URL is set.
 * The triggering workflow (.github/workflows/platform-scan-browser.yml) injects
 * the target + creds from repo secrets on workflow_dispatch.
 *
 * The interesting, testable logic lives in classifyPage (unit-tested). This spec
 * is just the signal-collection harness around it.
 */
import { test, expect, type Page } from "@playwright/test";
import { classifyPage, type PageObservation } from "@/lib/platform-scan/browser/classify";
import type { ScanFinding } from "@/lib/platform-scan/types";

const BASE_URL = process.env.TARGET_BASE_URL ?? "";
const ADMIN_EMAIL = process.env.TARGET_ADMIN_EMAIL ?? "";
const ADMIN_PASSWORD = process.env.TARGET_ADMIN_PASSWORD ?? "";
const INGEST_URL = process.env.INGEST_URL ?? "";
const INGEST_SECRET = process.env.INGEST_SECRET ?? "";
const PLATFORM = process.env.TARGET_PLATFORM ?? "self";

/** Routes to walk. journey is a human label that flows into evidence. */
const ROUTES: { path: string; journey: string; auth: "required" | "public" }[] = [
  { path: "/", journey: "landing", auth: "public" },
  { path: "/login", journey: "login", auth: "public" },
  { path: "/dashboard", journey: "dashboard", auth: "required" },
  { path: "/admin/agents", journey: "agent-roster", auth: "required" },
  { path: "/settings", journey: "settings", auth: "required" },
];

test.skip(!BASE_URL, "no target configured (set TARGET_BASE_URL)");

/** Best-effort form login against the target. Non-fatal: a failed login just
 *  means the authenticated routes get observed in their logged-out state. */
async function loginIfPossible(page: Page): Promise<void> {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return;
  try {
    await page.goto(new URL("/login", BASE_URL).toString(), { waitUntil: "domcontentloaded" });
    await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"], input[name="password"]', ADMIN_PASSWORD);
    await Promise.all([
      page.waitForLoadState("networkidle").catch(() => {}),
      page.click('button[type="submit"]'),
    ]);
  } catch {
    // Login is best-effort; continue and observe whatever renders.
  }
}

test("browser-journey scan: classify every route and ingest findings", async ({ page }) => {
  await loginIfPossible(page);

  const allFindings: ScanFinding[] = [];

  for (const route of ROUTES) {
    const consoleErrors: string[] = [];
    const cspViolations: string[] = [];
    const failedRequests: { url: string; status: number }[] = [];

    const onConsole = (msg: { type(): string; text(): string }) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    };
    const onResponse = (res: { status(): number; url(): string }) => {
      const status = res.status();
      if (status >= 400) failedRequests.push({ url: res.url(), status });
    };
    page.on("console", onConsole);
    page.on("response", onResponse);

    // Surface securitypolicyviolation events from inside the page.
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) => {
        const ev = e as SecurityPolicyViolationEvent;
        (window as unknown as { __csp?: string[] }).__csp ||= [];
        (window as unknown as { __csp?: string[] }).__csp!.push(
          `${ev.violatedDirective} ${ev.blockedURI}`,
        );
      });
    });

    const started = Date.now();
    let status: number | undefined;
    try {
      const resp = await page.goto(new URL(route.path, BASE_URL).toString(), {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });
      status = resp?.status();
      await page.waitForLoadState("networkidle").catch(() => {});
    } catch {
      // navigation failure leaves status undefined -> blank/observed below.
    }
    const durationMs = Date.now() - started;

    const cspFromPage = await page
      .evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])
      .catch(() => [] as string[]);
    cspViolations.push(...cspFromPage);

    const renderedContent = await page
      .evaluate(() => (document.body?.innerText ?? "").trim().length > 0)
      .catch(() => false);

    page.off("console", onConsole);
    page.off("response", onResponse);

    const obs: PageObservation = {
      route: route.path,
      journey: route.journey,
      status,
      consoleErrors,
      cspViolations,
      failedRequests,
      renderedContent,
      durationMs,
    };
    allFindings.push(...classifyPage(obs));
  }

  // Always POST: zero findings is a valid, healthy result worth recording.
  if (INGEST_URL && INGEST_SECRET) {
    const res = await page.request.post(INGEST_URL, {
      headers: { authorization: `Bearer ${INGEST_SECRET}` },
      data: { platform: PLATFORM, baseUrl: BASE_URL, findings: allFindings },
    });
    expect(res.status(), await res.text()).toBe(200);
  }
});
