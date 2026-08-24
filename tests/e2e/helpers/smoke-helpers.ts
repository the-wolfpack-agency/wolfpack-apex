/**
 * Shared helpers for the verify smoke suite.
 *
 * Each repo owns its own copy of these helpers (per engineering directive:
 * self-contained repos, no shared npm package). The shape is intentionally
 * aligned across repos so tests read the same way everywhere.
 */
import {
  expect,
  type APIRequestContext,
  type Page,
  type Response,
  type ConsoleMessage,
} from "@playwright/test";
import { BOOT_SPLASH_TESTID } from "@/lib/ui/boot-splash";

/** How long a route gets to boot and render its content before we call it
 *  broken. Production settled in about 8s when this was measured on
 *  2026-08-24, so this is generous on purpose: a slow render is a
 *  different complaint from a blank one. */
const DEFAULT_CONTENT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

export interface SmokeProbe {
  path: string;
  /** Case-insensitive text fragment that proves the page is not blank. */
  expectText: string;
  /**
   * For routes whose rendered content depends on account state, ANY of these
   * fragments proves a healthy authenticated render. Example: /setup shows the
   * wizard ("Set up") for a fresh workspace but redirects an already-onboarded
   * account to the dashboard shell ("Instinct"); both are valid, a 401 blank is
   * not. When set, this supersedes expectText for the body-text assertion.
   */
  expectAnyText?: string[];
  /** If true, expect JSON content-type (API endpoints). */
  json?: boolean;
  /** Allowed non-2xx status for the main document (e.g. 401 for pre-auth). */
  allowStatus?: number[];
  /**
   * How long the route gets to boot and render before the probe calls it
   * broken. Defaults to 30s, which is generous against production (it settled
   * in about 8s when measured on 2026-08-24). An explicit option rather than
   * an env var on purpose: an env var reads as a gate, and a spec that looks
   * gated on a secret is how a test comes to never run at all.
   */
  contentTimeoutMs?: number;
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
  // /login is "use client" and wraps the form in <Suspense> — under
  // `domcontentloaded`, the form may not be hydrated yet. Wait for the
  // input to actually appear before giving up (was: instant isVisible
  // check that returned false on a slow CI cold-start).
  const emailInput = page.locator(emailField).first();
  const formReady = await emailInput
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!formReady) return false;
  await emailInput.fill(target.email);
  await page.locator(passwordField).first().fill(target.password);
  await page.locator(submit).first().click();
  // Wait for navigation or a dashboard element.
  await page
    .waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 })
    .catch(() => null);
  return true;
}

/**
 * Returns true iff the real-login flow actually wrote a token into
 * localStorage. Use this when a spec needs to know whether to fall
 * back to a stubbed test token. `signInIfPossible` historically
 * returns `true` just for "attempt was made", so don't read it as
 * "session is real."
 */
export async function hasInstinctToken(page: Page): Promise<boolean> {
  const token = await page
    .evaluate(() => localStorage.getItem("instinct_token") ?? "")
    .catch(() => "");
  return Boolean(token);
}

/**
 * Install a stub token into localStorage on EVERY page mount in this
 * context AND route the auth endpoints to success responses so the
 * (dashboard) layout's fetchWithRefresh chain doesn't see an expired
 * stub token, call refresh, get 401, clearInstinctSession() (which
 * wipes our stub), and redirect to /login.
 *
 * Must be called BEFORE any navigation. Tests that intercept the data
 * API never actually validate the token server-side, so the stub is
 * safe.
 */
export async function stubInstinctSession(
  page: Page,
  overrides: { id?: string; role?: string; name?: string; email?: string } = {},
): Promise<void> {
  const user = {
    id: overrides.id ?? "u-test",
    role: overrides.role ?? "ops",
    name: overrides.name ?? "Test",
    email: overrides.email ?? "test@instinct.local",
  };
  // 1. Seed localStorage on every page mount.
  await page.addInitScript((u) => {
    if (!localStorage.getItem("instinct_token")) {
      localStorage.setItem("instinct_token", "test-token-not-validated");
      localStorage.setItem("instinct_user", JSON.stringify(u));
    }
  }, user);
  // 2. Keep the auth-refresh chain happy so client-auth.ts doesn't
  //    clearInstinctSession() and redirect to /login.
  await page.route("**/api/auth/whoami", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: "test-token-not-validated", user }),
    });
  });
  await page.route("**/api/auth/refresh", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: "test-token-not-validated", user }),
    });
  });
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
      const url = resp.url();
      // Fire-and-forget dashboard-layout side-effect endpoints. In shadow
      // mode (or with a stub token), these return 401 cleanly and the
      // page keeps working — they don't affect user-visible behavior.
      // Allowlist 401s on these so the network-failure collector doesn't
      // sink real-functional tests with telemetry noise.
      //
      // - /api/auth/whoami: layout's auth probe; 401 = "redirect to /login"
      // - /api/auth/refresh: silent token-refresh; 401 = "session ended"
      // - /api/analytics: client-side event POST
      // - /api/notifications/unread-count: top-right bell badge
      // - /api/microsoft/messages/unread-count: email badge
      // - /api/ms/chats/unread-count: Teams badge
      // - /api/assistant?conversations=...: Wolfpack Assistant sidebar count
      // - /api/me/welcome-tooltip: dismissable onboarding tooltip
      // - /api/user-nav-prefs: per-user nav visibility prefs
      const BENIGN_401_PATHS = [
        /\/api\/auth\/whoami(\?|$)/,
        /\/api\/auth\/refresh(\?|$)/,
        /\/api\/analytics(\?|$|\/)/,
        /\/api\/notifications\/unread-count(\?|$)/,
        /\/api\/microsoft\/messages\/unread-count(\?|$)/,
        /\/api\/ms\/chats\/unread-count(\?|$)/,
        /\/api\/assistant(\?|$|\/)/,
        /\/api\/me\/welcome-tooltip(\?|$)/,
        /\/api\/user-nav-prefs(\?|$)/,
        // /merge-suggestions is a fire-and-forget enrichment fetch on the
        // summary detail page — if it 401s the main summary content still
        // renders, so don't sink summary specs on it.
        /\/api\/automations\/[^/]+\/summaries\/[^/]+\/merge-suggestions(\?|$)/,
      ];
      if (status === 401 && BENIGN_401_PATHS.some((rx) => rx.test(url))) return;
      failures.push({
        kind: "network",
        detail: `${status} ${req.method()} ${url}`,
      });
    }
  });

  return () => failures.slice();
}

/**
 * Wait until a page has actually RENDERED, then return its text.
 *
 * Ten places in this suite had copied the same two lines: navigate with
 * waitUntil "domcontentloaded", then read body.innerText() straight away and
 * assert a word is in it. At that instant every authenticated route in this
 * app shows one thing, "Loading Instinct…", so the assertion is about the
 * loading screen. On 2026-08-24 that was found to have kept Verify red on
 * main since 2026-06-28, and to account for several of the failures the
 * reality check was quietly swallowing.
 *
 * THE SPLASH AND THE TEXT ARE CHECKED TOGETHER, not one after the other.
 * Before React mounts, the splash is not in the DOM either, so "the splash is
 * gone" is briefly true of a page that has rendered nothing. Both at once is
 * only ever true of a real render.
 *
 * Returns the settled body text, lowercased, so callers can go on asserting
 * against the page they now know is there.
 */
export async function expectRendered(
  page: Page,
  where: string,
  candidates: string[],
  opts: { message?: string; timeoutMs?: number } = {},
): Promise<string> {
  const wanted = candidates.map((t) => t.toLowerCase());
  const splash = page.locator(`[data-testid="${BOOT_SPLASH_TESTID}"]`);
  const budgetMs = opts.timeoutMs ?? DEFAULT_CONTENT_TIMEOUT_MS;
  const deadline = Date.now() + budgetMs;
  let booting = false;
  let bodyText = "";
  let ready = false;
  while (!ready) {
    booting = (await splash.count()) > 0;
    bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    ready = !booting && wanted.some((t) => bodyText.includes(t));
    if (ready || Date.now() >= deadline) break;
    await page.waitForTimeout(POLL_INTERVAL_MS);
  }
  // Two different failures, said differently. A page stuck on the splash is a
  // boot problem; a page showing something else is a content problem. Calling
  // both "text not found" is what sent somebody looking at /tasks for two
  // months while the page rendered perfectly well a second later.
  expect(
    ready,
    booting
      ? `${where} never finished booting: still showing the loading splash after ${budgetMs}ms`
      : `${opts.message ?? `None of [${candidates.join(", ")}] found on ${where}`}` +
        ` (after ${budgetMs}ms; body was ${JSON.stringify(bodyText.slice(0, 300))})`,
  ).toBe(true);
  return bodyText;
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

  // One implementation of "has this actually rendered", shared with every
  // other spec that asks the question. See expectRendered above.
  const candidates = probe.expectAnyText ?? [probe.expectText];
  await expectRendered(page, probe.path, candidates, {
    timeoutMs: probe.contentTimeoutMs,
  });

  // 3-second idle window for async CSP/network failures to surface.
  await page.waitForTimeout(3_000);
  const failures = snapshot();
  expect(
    failures,
    `CSP/network failures on ${probe.path}:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`,
  ).toEqual([]);
}

// ---------------------------------------------------------------------------
// Reality-check suite helpers (sites-preview-reality-check,
// sites-upload-reality-check, sites-designer-journey).
//
// These three specs answer: "does the pixel the user actually sees match
// what we claim is deployed?" — the layer that the 400+ jest suite can't
// cover. The helpers below are shared across all three.
// ---------------------------------------------------------------------------

/**
 * Read the auth token the client-side code stashes after login.
 * Looks at both keys since the rename from apex → instinct.
 */
export async function authToken(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      localStorage.getItem("instinct_token") ??
      localStorage.getItem("apex_token") ??
      "",
  );
}

/**
 * Fire-and-forget learning-loop signal. Every reality-check spec calls
 * this at the end of its run (pass OR fail) so we get a feedback loop
 * on which specs flap vs which specs never fail.
 *
 * Silently swallows errors — analytics must NEVER fail a test.
 */
export async function recordRealityCheckRun(
  request: APIRequestContext,
  target: SmokeTarget,
  token: string | null,
  payload: {
    spec: string;
    result: "pass" | "fail" | "skip";
    duration_ms: number;
    note?: string;
  },
): Promise<void> {
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers["authorization"] = `Bearer ${token}`;
    await request.post(`${target.baseUrl}/api/analytics`, {
      headers,
      data: {
        event: "e2e.reality_check_ran",
        metadata: {
          spec: payload.spec,
          result: payload.result,
          duration_ms: payload.duration_ms,
          env: target.baseUrl,
          ...(payload.note ? { note: payload.note } : {}),
        },
      },
      timeout: 5_000,
    });
  } catch {
    // Analytics never fails a test. Learning signal is best-effort.
  }
}

/**
 * Grab the "headline" of a rendered site — the first visible <h1>, then
 * the first <h2>, then the first 120 chars of body text as a fallback.
 * Used to compare the detail-page iframe content against the raw
 * deployed URL for parity.
 */
export async function extractHeadline(page: Page): Promise<string> {
  const h1 = await page.locator("h1").first().innerText().catch(() => "");
  if (h1 && h1.trim().length > 0) return h1.trim();
  const h2 = await page.locator("h2").first().innerText().catch(() => "");
  if (h2 && h2.trim().length > 0) return h2.trim();
  const body = await page.locator("body").innerText().catch(() => "");
  return body.trim().slice(0, 120);
}

/**
 * Stub-text detector for the 9097a47-class regression. Returns the first
 * stub phrase found (or null). Stub phrases are strings that ONLY belong
 * on a pre-deploy brief — if they show up on a project whose preview_url
 * is set, the internal /sites/[id]/preview route is rendering the
 * SiteBrief stub instead of iframing the real deployed site.
 */
export function findPreviewStubPhrase(bodyText: string): string | null {
  const stubs = [
    "Edit this brief in Instinct",
    "populate the rest",
    "Get in touch",
  ];
  const lower = bodyText.toLowerCase();
  for (const s of stubs) {
    if (lower.includes(s.toLowerCase())) return s;
  }
  return null;
}
