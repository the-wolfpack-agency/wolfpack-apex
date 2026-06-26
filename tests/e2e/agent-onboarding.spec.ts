/**
 * Agent client-onboarding UI e2e — the FULL flow against a live target.
 *
 * Drives the DEPLOYED Wolfpack Instinct admin through the journey a manager
 * actually walks to put an agent to work on a client's system:
 *   1. log in to Instinct,
 *   2. onboard an agent principal (mints the one-time secret),
 *   3. connect the agent to a target client platform (saved form login),
 *   4. run an authenticated platform scan and review the findings rollup.
 *
 * Each step asserts a 200-class outcome AND visible content — never just
 * "not an error". A console collector fails the test on any CSP violation so a
 * blank-page / blocked-resource regression can't slip through green.
 *
 * INERT in normal CI: the whole spec skips unless deployed Instinct + admin
 * creds are present (mirrors tests/e2e/platform-scan-browser.spec.ts's env
 * gating). The triggering workflow (.github/workflows/agent-onboarding-e2e.yml)
 * injects the base URL, admin creds, and target creds from repo secrets on
 * workflow_dispatch.
 */
import { test, expect, type Page } from "@playwright/test";

// Instinct (the admin under test) + its admin login.
const INSTINCT_BASE_URL = process.env.INSTINCT_BASE_URL ?? "";
const ADMIN_EMAIL = process.env.INSTINCT_ADMIN_EMAIL ?? "";
const ADMIN_PASSWORD = process.env.INSTINCT_ADMIN_PASSWORD ?? "";

// The target client platform the agent is onboarded against. Slug + login
// shape default to the beyond-sku e2e fixture so a manual run needs only the
// target's username/password wired as secrets.
const TARGET_NAME = process.env.TARGET_NAME ?? "beyond-e2e";
const TARGET_BASE_URL = process.env.TARGET_BASE_URL ?? "https://beyond-sku.vercel.app";
const TARGET_LOGIN_PATH = process.env.TARGET_LOGIN_PATH ?? "/api/auth/login";
const TARGET_USERNAME = process.env.TARGET_USERNAME ?? "";
const TARGET_PASSWORD = process.env.TARGET_PASSWORD ?? "";

// Inert without a deployed Instinct + admin creds (same idiom as the
// platform-scan browser spec, which skips without TARGET_BASE_URL).
test.skip(
  !process.env.INSTINCT_BASE_URL || !process.env.INSTINCT_ADMIN_EMAIL,
  "onboarding e2e needs deployed Instinct + admin creds",
);

/** Absolute URL on the deployed Instinct host for a given path. */
function url(path: string): string {
  return new URL(path, INSTINCT_BASE_URL).toString();
}

/**
 * Wires a console collector that records CSP violations. A CSP violation surfaces
 * as a console error mentioning "Content Security Policy" / "Refused to" AND as a
 * securitypolicyviolation event in-page; we capture both. The returned array is
 * asserted empty at the end of the flow so a blocked script/style (the classic
 * blank-dashboard cause) fails the test loudly.
 */
function collectCspViolations(page: Page): string[] {
  const cspViolations: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (/content security policy|refused to (load|execute|connect|apply)/i.test(text)) {
      cspViolations.push(text);
    }
  });
  page.on("pageerror", (err) => {
    if (/content security policy/i.test(err.message)) cspViolations.push(err.message);
  });
  return cspViolations;
}

/** Surface in-page securitypolicyviolation events too (some CSP blocks never
 *  reach the console channel). Drained into the collector at assert time. */
async function armInPageCsp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      const ev = e as SecurityPolicyViolationEvent;
      (window as unknown as { __csp?: string[] }).__csp ||= [];
      (window as unknown as { __csp?: string[] }).__csp!.push(
        `${ev.violatedDirective} ${ev.blockedURI}`,
      );
    });
  });
}

async function drainInPageCsp(page: Page): Promise<string[]> {
  return page
    .evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])
    .catch(() => [] as string[]);
}

/** Authenticates to Instinct via the password form and waits for the admin
 *  shell. Asserts we leave /login (a stuck login leaves the URL on /login). */
async function login(page: Page): Promise<void> {
  const resp = await page.goto(url("/login"), { waitUntil: "domcontentloaded" });
  expect(resp?.status(), "login page should load 200-class").toBeLessThan(400);

  await page.getByTestId("login-email").fill(ADMIN_EMAIL);
  await page.getByTestId("login-password").fill(ADMIN_PASSWORD);
  // The submit button carries no testid; it is the only submit in the form.
  await page.locator('form button[type="submit"]').click();

  // A successful login navigates off /login into the authenticated app.
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 20_000 })
    .not.toBe("/login");
}

test.describe.serial("agent client-onboarding flow (live target)", () => {
  // One agent name per run so re-runs never collide on the unique-name 409.
  const agentName = `E2E Onboard ${Date.now()}`;
  let cspViolations: string[] = [];

  test("log in, onboard an agent, connect a target, run an authenticated scan", async ({
    page,
  }) => {
    cspViolations = collectCspViolations(page);
    await armInPageCsp(page);

    // 1) LOG IN ----------------------------------------------------------------
    await login(page);
    // Land on the agents roster and confirm the authenticated admin page rendered.
    const agentsResp = await page.goto(url("/admin/agents"), {
      waitUntil: "domcontentloaded",
    });
    expect(agentsResp?.status(), "agents page should load 200-class").toBeLessThan(400);
    await expect(page.getByTestId("admin-agents-page")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("agent-onboard-form")).toBeVisible();

    // 2) ONBOARD AN AGENT (with email invite) ----------------------------------
    // name + role + optional invite-by-email (emails the join link + one-time
    // secret). A successful onboard renders the one-time secret panel + a roster row.
    await page.getByTestId("agent-onboard-name").fill(agentName);
    await page.getByTestId("agent-onboard-role").selectOption("dev");
    // Invite-by-email is the "client onboarding by email" leg of the flow.
    await page.getByTestId("agent-onboard-invite-email").fill(process.env.INVITE_EMAIL ?? ADMIN_EMAIL);
    await page.getByTestId("agent-onboard-submit").click();

    // Success = the one-time onboarding secret is shown exactly once.
    await expect(page.getByTestId("agent-onboarding-secret")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("agent-onboarding-secret-value")).not.toBeEmpty();
    // The new agent now appears on the roster; click into it to capture its id.
    const newRow = page
      .locator('[data-testid^="agent-row-"]')
      .filter({ hasText: agentName })
      .first();
    await expect(newRow).toBeVisible({ timeout: 15_000 });
    await newRow.locator("a").first().click();

    // We are now on the agent detail page; pull the id out of the URL.
    await expect(page.getByTestId("admin-agent-page")).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => /\/admin\/agents\/[^/]+$/.test(page.url())).toBe(true);
    const agentId = new URL(page.url()).pathname.split("/").pop() ?? "";
    expect(agentId, "captured agent id from detail URL").not.toBe("");
    await expect(page.getByTestId("agent-name")).toHaveText(agentName);

    // 3) CONNECT THE TARGET SYSTEM --------------------------------------------
    // The "Connected systems" add form wires the form-login the operator uses on
    // the client platform, so the agent can run an authenticated scan of it.
    await expect(page.getByTestId("agent-connections-section")).toBeVisible({
      timeout: 15_000,
    });
    const connForm = page.getByTestId("add-connection-form");
    await expect(connForm).toBeVisible();
    await connForm.getByTestId("conn-name").fill(TARGET_NAME);
    await connForm.getByTestId("conn-base-url").fill(TARGET_BASE_URL);
    await connForm.getByTestId("conn-login-path").fill(TARGET_LOGIN_PATH);
    await connForm.getByTestId("conn-username").fill(TARGET_USERNAME);
    await connForm.getByTestId("conn-password").fill(TARGET_PASSWORD);
    await page.getByTestId("add-connection-submit").click();

    // The masked connection row renders on success (password never echoed back).
    await expect(page.getByTestId(`connection-row-${TARGET_NAME}`)).toBeVisible({
      timeout: 20_000,
    });
    // Its "Run authenticated scan" link confirms the saved-login connection wired.
    await expect(page.getByTestId(`scan-link-${TARGET_NAME}`)).toBeVisible();

    // 4) RUN AN AUTHENTICATED SCAN --------------------------------------------
    const scansResp = await page.goto(url("/admin/platform-scans"), {
      waitUntil: "domcontentloaded",
    });
    expect(scansResp?.status(), "platform-scans page should load 200-class").toBeLessThan(
      400,
    );
    await expect(page.getByTestId("platform-scans-page")).toBeVisible({ timeout: 15_000 });

    // Select the just-connected target. The targets selector is populated from
    // the connectors list, so poll until our target appears as an option.
    const platformSelect = page.getByTestId("platform-select");
    await expect(platformSelect).toBeVisible();
    await expect
      .poll(
        async () =>
          platformSelect.locator(`option[value="${TARGET_NAME}"]`).count(),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
    await platformSelect.selectOption(TARGET_NAME);
    await page.getByTestId("mode-select").selectOption("http");

    const runScan = page.getByTestId("run-scan");
    await expect(runScan).toBeEnabled();
    await runScan.click();

    // The scan can take a while (it crawls the live target). It finishes when
    // the run button re-enables and the run summary appears.
    await expect(runScan).toBeEnabled({ timeout: 90_000 });
    const scanSummary = page.getByTestId("scan-summary");
    await expect(scanSummary).toBeVisible({ timeout: 90_000 });
    // The summary names the platform it scanned.
    await expect(scanSummary).toContainText(TARGET_NAME);

    // The severity rollup must render — either populated counts (findings-list)
    // or an explicit empty state (findings-empty). Never a blank page / throw.
    await expect(page.getByTestId("findings-summary")).toBeVisible({ timeout: 15_000 });
    for (const sev of ["critical", "high", "medium", "low"] as const) {
      await expect(page.getByTestId(`sev-count-${sev}`)).toBeVisible();
    }
    const findingsList = page.getByTestId("findings-list");
    const findingsEmpty = page.getByTestId("findings-empty");
    // Exactly one of the two outcome states must be present.
    await expect
      .poll(
        async () =>
          (await findingsList.count()) + (await findingsEmpty.count()),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    // 5) NO CSP VIOLATIONS ANYWHERE IN THE FLOW -------------------------------
    cspViolations.push(...(await drainInPageCsp(page)));
    expect(cspViolations, `CSP violations: ${cspViolations.join(" | ")}`).toHaveLength(0);
  });
});
