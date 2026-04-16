/**
 * Shared helpers for the verify smoke suite.
 *
 * Each repo owns its own copy of these helpers (per engineering directive:
 * self-contained repos, no shared npm package). The shape is intentionally
 * aligned across repos so tests read the same way everywhere.
 */
import { expect, type Page, type Response, type ConsoleMessage } from "@playwright/test";

export interface SmokeProbe {
  path: string;
  /** Case-insensitive text fragment that proves the page is not blank. */
  expectText: string;
  /** If true, expect JSON content-type (API endpoints). */
  json?: boolean;
  /** Allowed non-2xx status for the main document (e.g. 401 for pre-auth). */
  allowStatus?: number[];
}

export interface SmokeTarget {
  /** The deployed URL if set, otherwise local fallback. */
  baseUrl: string;
  /** Whether the baseUrl is the production deployed URL (not localhost). */
  isProduction: boolean;
  email?: string;
  password?: string;
}

export function resolveSmokeTarget(): SmokeTarget {
  const prod = process.env.PROD_URL?.replace(/\/$/, "");
  const baseUrl = prod || "http://localhost:3000";
  return {
    baseUrl,
    isProduction: !!prod,
    email: process.env.SMOKE_TEST_EMAIL,
    password: process.env.SMOKE_TEST_PASSWORD,
  };
}

/**
 * Attempt credentials-based sign-in. Returns false if the caller should skip
 * the test (e.g. missing env vars); throws on real sign-in failures.
 */
export async function signInIfPossible(
  page: Page,
  target: SmokeTarget,
  opts: { emailField?: string; passwordField?: string; submitSelector?: string } = {},
): Promise<boolean> {
  if (!target.email || !target.password) return false;
  const emailField = opts.emailField ?? 'input[name="email"], input[type="email"]';
  const passwordField = opts.passwordField ?? 'input[name="password"], input[type="password"]';
  const submit = opts.submitSelector ?? 'button[type="submit"]';

  await page.goto(`${target.baseUrl}/login`, { waitUntil: "domcontentloaded" });
  const emailInput = page.locator(emailField).first();
  if (!(await emailInput.isVisible().catch(() => false))) return false;
  await emailInput.fill(target.email);
  await page.locator(passwordField).first().fill(target.password);
  await page.locator(submit).first().click();
  // Wait for navigation or a dashboard element.
  await page
    .waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 })
    .catch(() => null);
  return true;
}

export interface ConsoleFailure {
  kind: "console" | "network";
  detail: string;
}

/** Attach console + network listeners; returns a function that snapshots collected failures. */
export function collectConsoleAndNetworkFailures(page: Page) {
  const failures: ConsoleFailure[] = [];

  page.on("console", (msg: ConsoleMessage) => {
    const text = msg.text();
    // CSP violations surface as error-level console messages mentioning CSP.
    if (/content security policy|csp violation|refused to/i.test(text)) {
      failures.push({ kind: "console", detail: `CSP: ${text}` });
    }
  });

  page.on("pageerror", (err) => {
    failures.push({ kind: "console", detail: `pageerror: ${err.message}` });
  });

  page.on("response", (resp: Response) => {
    const req = resp.request();
    const type = req.resourceType();
    if (type !== "xhr" && type !== "fetch") return;
    const status = resp.status();
    // 401/403/5xx on XHR/fetch indicates a broken call from the page.
    if (status === 401 || status === 403 || status >= 500) {
      failures.push({
        kind: "network",
        detail: `${status} ${req.method()} ${resp.url()}`,
      });
    }
  });

  return () => failures.slice();
}

/** Probe one path: HTTP 200, expected text visible, zero CSP/network failures. */
export async function probePath(
  page: Page,
  target: SmokeTarget,
  probe: SmokeProbe,
) {
  const snapshot = collectConsoleAndNetworkFailures(page);
  const allowed = new Set([200, ...(probe.allowStatus ?? [])]);

  const response = await page.goto(`${target.baseUrl}${probe.path}`, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  const status = response?.status() ?? 0;
  expect(
    allowed.has(status),
    `GET ${probe.path} → ${status} (expected one of ${[...allowed].join(",")})`,
  ).toBe(true);

  if (probe.json) {
    const contentType = response?.headers()["content-type"] ?? "";
    expect(contentType, `Content-Type for ${probe.path}`).toMatch(/json/i);
    return;
  }

  // Assert the expected text is present somewhere in the rendered body.
  const bodyText = await page.locator("body").innerText().catch(() => "");
  expect(
    bodyText.toLowerCase().includes(probe.expectText.toLowerCase()),
    `Expected text "${probe.expectText}" not found on ${probe.path}`,
  ).toBe(true);

  // 3-second idle window for async CSP/network failures to surface.
  await page.waitForTimeout(3_000);
  const failures = snapshot();
  expect(
    failures,
    `CSP/network failures on ${probe.path}:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`,
  ).toEqual([]);
}
