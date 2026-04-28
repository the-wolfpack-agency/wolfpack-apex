/**
 * Support — full ticket-creation E2E.
 *
 * Walks the operator journey through every surface we shipped on
 * 2026-04-28:
 *
 *   1. /support list page loads (200, filter pills + CTA visible).
 *   2. /support/new — fill the form, submit, redirect to /support/[id]
 *      with HTTP 201 on POST /api/support/tickets.
 *   3. /support/[id] — verify AI auto-categorization fired (category
 *      != general, AI pill visible, confidence ≥ 60%).
 *   4. AI draft generation populated — non-empty + contains a relevant
 *      keyword + textarea is editable.
 *   5. Regenerate draft — POST /api/support/tickets/[id]/draft returns
 *      200 and the textarea repopulates.
 *   6. Send modal opens with audience-correct From: pre-fill, Subject
 *      pre-fill, and the draft body. The modal is closed without
 *      actually sending — we never want this spec to fan out real email.
 *   7. Audience post-create override — checked against the rendered DOM:
 *      TicketDetail does NOT expose an audience picker after create
 *      (only category Change), so this step asserts the limitation
 *      explicitly. See the report for the resulting UI gap.
 *   8. Feedback widget — covered by unit + contract tests
 *      (TicketDetail.test.tsx + tickets-feedback.test.ts). Skipped here
 *      to avoid a real email send.
 *
 * Every step asserts:
 *   - HTTP 200/201 (NOT just "not 500"); 401 manifests as a blank
 *     dashboard so we explicitly reject it.
 *   - Zero CSP violations / pageerrors during the journey.
 *   - Zero 401/403/5xx XHR/fetch responses while we drive the page.
 *   - Real AI integration is exercised — categorizer + drafter are NOT
 *     mocked. We DO want this spec to prove the live Azure OpenAI
 *     wiring works end-to-end, just like it did when we shipped today.
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD: skipped when creds
 * are missing (local dev without the production credential set). Per
 * /Users/nicholashomyk/.claude/CLAUDE.md, smoke specs that hit live
 * services must skip cleanly rather than fail when the credential
 * inputs are absent.
 *
 * Cleanup: each run inserts a real row in the support_tickets table.
 * The title is timestamped so consecutive runs don't collide. Operators
 * can clean up via DELETE /api/support/tickets/[id] if needed.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

test.describe("/support — full ticket-creation flow", () => {
  test("list → create → AI categorize → AI draft → regenerate → send modal", async ({
    page,
  }) => {
    const target = resolveSmokeTarget();

    if (!target.email || !target.password) {
      test.skip(true, "SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD required");
      return;
    }

    const failures = collectConsoleAndNetworkFailures(page);

    const signedIn = await signInIfPossible(page, target);
    expect(signedIn, "sign-in attempt must complete").toBe(true);

    /* ------------------------------------------------------------------ */
    /* Step 1 — /support list page                                         */
    /* ------------------------------------------------------------------ */
    /* Wait for the GET /api/support/tickets fetch the list page fires
       on mount, so an auth/capability problem fails fast with the
       actual status code instead of a "row never rendered" timeout. */
    const listApiPromise = page.waitForResponse(
      (resp) =>
        resp.url().includes("/api/support/tickets") &&
        resp.request().method() === "GET",
      { timeout: 20_000 },
    );

    const listResp = await page.goto(`${target.baseUrl}/support`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(
      listResp?.status(),
      `GET /support status (401 = blank page; we want 200)`,
    ).toBe(200);

    const listApi = await listApiPromise;
    expect(
      listApi.status(),
      `GET /api/support/tickets returned ${listApi.status()}. ` +
        `If 401 with capability=automations.run, the SMOKE_TEST user lacks ` +
        `that capability — grant it via the role-capabilities map.`,
    ).toBe(200);

    /* "Support" h1 visible — proves the page hydrated past the auth
       gate (which renders null until authChecked is true). */
    await expect(
      page.getByRole("heading", { name: "Support", level: 1 }),
    ).toBeVisible({ timeout: 10_000 });

    /* Status filter pills (the audience All/Client/Internal pills are
       NOT wired into /support today — see report. Status pills are
       the canonical filter row.) */
    await expect(page.getByTestId("ticket-list-filters")).toBeVisible();
    await expect(page.getByTestId("ticket-filter-all")).toBeVisible();
    await expect(page.getByTestId("ticket-filter-open")).toBeVisible();
    await expect(page.getByTestId("ticket-filter-drafted")).toBeVisible();
    await expect(page.getByTestId("ticket-filter-sent")).toBeVisible();
    await expect(page.getByTestId("ticket-filter-resolved")).toBeVisible();

    /* New ticket CTA */
    const newCta = page.getByTestId("support-new-cta");
    await expect(newCta).toBeVisible();
    await expect(newCta).toHaveText(/new ticket/i);

    /* ------------------------------------------------------------------ */
    /* Step 2 — create a ticket via the UI                                 */
    /* ------------------------------------------------------------------ */
    await newCta.click();
    await page.waitForURL(/\/support\/new$/, { timeout: 10_000 });
    await expect(page.getByTestId("ticket-form")).toBeVisible({
      timeout: 10_000,
    });

    const stamp = Date.now();
    const ticketTitle = `E2E Test: Outlook MFA test ${stamp}`;
    const ticketBody =
      "User got an MFA prompt and now can't sign in. " +
      "Authenticator app stopped sending notifications.";

    await page.getByTestId("ticket-form-audience").selectOption("internal");
    await page.getByTestId("ticket-form-title").fill(ticketTitle);
    await page.getByTestId("ticket-form-body").fill(ticketBody);
    await page.getByTestId("ticket-form-severity").selectOption("p2");
    /* Leave category at the default "general" so the auto-categorizer
       runs on the server (it skips when the operator picks anything
       other than missing/general). */

    /* Wait for the POST /api/support/tickets call AND the redirect.
       The submit handler awaits the POST then router.push — so we
       hold the response promise and click in the same tick. */
    const postPromise = page.waitForResponse(
      (resp) =>
        resp.url().includes("/api/support/tickets") &&
        resp.request().method() === "POST",
      { timeout: 30_000 },
    );

    await page.getByTestId("ticket-form-submit").click();

    const postResp = await postPromise;
    expect(
      postResp.status(),
      `POST /api/support/tickets returned ${postResp.status()}. ` +
        `Body: ${await postResp.text().catch(() => "<unreadable>")}`,
    ).toBe(201);

    const created = (await postResp.json()) as { id?: string };
    expect(created.id, "POST response must carry ticket id").toBeTruthy();

    /* Redirect to /support/<uuid> (the route uses encodeURIComponent
       so the id appears verbatim — UUIDs need no escaping). */
    await page.waitForURL(/\/support\/[0-9a-f-]{8,}$/i, { timeout: 15_000 });

    /* ------------------------------------------------------------------ */
    /* Step 3 — auto-categorization                                        */
    /* ------------------------------------------------------------------ */
    await expect(page.getByTestId("ticket-detail-root")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("ticket-detail-header")).toBeVisible();

    const categoryChip = page.getByTestId("ticket-detail-category-chip");
    await expect(categoryChip).toBeVisible({ timeout: 10_000 });

    /* category != "general" — the categorizer should classify an MFA /
       authenticator ticket as m365 or urgent. We don't pin to one
       specific value because the AI may legitimately split the call. */
    const chipCategory = await categoryChip.getAttribute("data-category");
    expect(
      chipCategory,
      `Auto-categorization should not leave the ticket as 'general' for an ` +
        `Outlook MFA prompt. Got: ${chipCategory}`,
    ).not.toBe("general");
    expect(chipCategory).toBeTruthy();

    /* category_source === "ai" — proves the categorizer ran (vs. the
       operator's manual default). */
    const chipSource = await categoryChip.getAttribute("data-category-source");
    expect(
      chipSource,
      `Category source should be 'ai' after auto-categorization. ` +
        `Got: ${chipSource}`,
    ).toBe("ai");

    /* "AI" pill rendered next to the category */
    const aiPill = page.getByTestId("ticket-detail-category-source");
    await expect(aiPill).toBeVisible();
    await expect(aiPill).toContainText(/AI/i);

    /* Confidence ≥ 60% — categorizer's own floor is 0.6 below which it
       coerces to 'general', so passing this gate also confirms it
       stayed above the threshold. The visible chip prints e.g. "85%". */
    const confidenceEl = page.getByTestId("ticket-detail-category-confidence");
    await expect(confidenceEl).toBeVisible();
    const confText = (await confidenceEl.innerText()).trim();
    const confMatch = confText.match(/(\d+)\s*%/);
    expect(
      confMatch,
      `Confidence chip should render an integer percent. Got: "${confText}"`,
    ).not.toBeNull();
    const confPct = confMatch ? parseInt(confMatch[1], 10) : 0;
    expect(
      confPct,
      `AI category confidence should be ≥ 60% (got ${confPct}%).`,
    ).toBeGreaterThanOrEqual(60);

    /* ------------------------------------------------------------------ */
    /* Step 4 — AI draft generation                                        */
    /* ------------------------------------------------------------------ */
    const draftSection = page.getByTestId("ticket-detail-draft");
    await expect(draftSection).toBeVisible({ timeout: 10_000 });

    const draftTextarea = page.getByTestId("ticket-detail-draft-textarea");
    await expect(draftTextarea).toBeVisible();
    const initialDraft = (await draftTextarea.inputValue()).trim();
    expect(
      initialDraft.length,
      `AI draft should be non-empty after create+draft round-trip.`,
    ).toBeGreaterThan(0);

    /* Loose keyword check — proves the draft is at least topical. The
       drafter is pattern + AI-driven so we accept any of several known
       phrases that an MFA-related response would naturally contain. */
    const keywordHit = /MFA|authenticator|wolfpack team|sign-in|sign in/i.test(
      initialDraft,
    );
    expect(
      keywordHit,
      `Draft should mention at least one of MFA / authenticator / ` +
        `Wolfpack Team / sign-in. Draft was:\n${initialDraft.slice(0, 400)}`,
    ).toBe(true);

    /* Textarea is editable: focus → type → blur → value persists. */
    await draftTextarea.focus();
    const probeSuffix = `\n\n[E2E edit probe ${stamp}]`;
    await draftTextarea.fill(initialDraft + probeSuffix);
    await draftTextarea.blur();
    expect(await draftTextarea.inputValue()).toContain("[E2E edit probe");

    /* ------------------------------------------------------------------ */
    /* Step 5 — regenerate draft                                           */
    /* ------------------------------------------------------------------ */
    const regenPromise = page.waitForResponse(
      (resp) =>
        /\/api\/support\/tickets\/[^/]+\/draft$/.test(resp.url()) &&
        resp.request().method() === "POST",
      { timeout: 30_000 },
    );

    await page.getByTestId("ticket-detail-regenerate").click();
    const regenResp = await regenPromise;
    expect(
      regenResp.status(),
      `POST /api/support/tickets/[id]/draft returned ${regenResp.status()}.`,
    ).toBe(200);

    /* Draft re-renders post-regen. The draft skeleton ("Drafting
       response…") shows during the round-trip; once regenerating
       flips back to false, the textarea is back. We wait for the
       textarea to be visible (not the skeleton) and then assert
       non-empty. */
    await expect(page.getByTestId("ticket-detail-draft-textarea")).toBeVisible(
      { timeout: 15_000 },
    );
    const regenDraft = (
      await page.getByTestId("ticket-detail-draft-textarea").inputValue()
    ).trim();
    expect(
      regenDraft.length,
      `Draft must be non-empty after regenerate.`,
    ).toBeGreaterThan(0);

    /* No error banner */
    await expect(
      page.getByTestId("ticket-detail-draft-error"),
    ).not.toBeVisible();

    /* ------------------------------------------------------------------ */
    /* Step 6 — send modal opens with correct pre-fill                     */
    /* ------------------------------------------------------------------ */
    await page.getByTestId("ticket-detail-open-send").click();
    const sendModal = page.getByTestId("ticket-detail-send-modal");
    await expect(sendModal).toBeVisible({ timeout: 5_000 });

    /* From: input. Audience=internal so the From: pre-fill should be
       the operator's own email (the SMOKE_TEST_EMAIL we signed in
       with), with a graceful fallback to support@thewolfpack.agency
       if the user blob lacks an email. We accept either to keep the
       spec resilient against a test user whose email isn't stored
       client-side. */
    const fromInput = page.getByTestId("send-modal-from-input");
    await expect(fromInput).toBeVisible();
    const fromValue = (await fromInput.inputValue()).trim();
    expect(
      fromValue.length,
      "From: address should never be empty in the send modal.",
    ).toBeGreaterThan(0);
    expect(
      fromValue === target.email ||
        fromValue === "support@thewolfpack.agency",
      `From: should be operator email (${target.email}) or fallback ` +
        `support@thewolfpack.agency. Got: ${fromValue}`,
    ).toBe(true);

    /* Subject pre-filled with "Re: <title>" */
    const subjectInput = page.getByTestId("send-modal-subject");
    await expect(subjectInput).toBeVisible();
    const subjectValue = await subjectInput.inputValue();
    expect(subjectValue).toContain("Re: E2E Test");

    /* Body contains the (post-regen) draft text */
    const sendBody = page.getByTestId("send-modal-body");
    await expect(sendBody).toBeVisible();
    const sendBodyValue = (await sendBody.inputValue()).trim();
    expect(
      sendBodyValue.length,
      "Send-modal body must carry the draft text.",
    ).toBeGreaterThan(0);

    /* Close the modal WITHOUT sending. Real email is intentionally
       skipped — we never want this spec to fan out a message. */
    await page.getByTestId("send-modal-cancel").click();
    await expect(sendModal).not.toBeVisible({ timeout: 5_000 });

    /* ------------------------------------------------------------------ */
    /* Step 7 — audience override (NOT supported post-create)              */
    /* ------------------------------------------------------------------ */
    /* TicketDetail.tsx exposes a CategoryChip with a "Change" button
       (data-testid="ticket-detail-category-change") but does NOT
       expose an audience picker after the ticket is created. The
       audience is set at create time via TicketForm and never
       editable thereafter. We assert that absence here so a future
       change to add a post-create audience picker is caught by this
       spec failing on this exact line. See report for follow-up. */
    await expect(
      page.getByTestId("ticket-detail-audience-change"),
    ).toHaveCount(0);

    /* ------------------------------------------------------------------ */
    /* Step 8 — feedback widget                                             */
    /* ------------------------------------------------------------------ */
    /* Skipped intentionally — the feedback widget only renders after
       the ticket flips to 'sent', which would require an actual email
       send. Covered by:
         - src/app/(dashboard)/support/_components/__tests__/TicketDetail.test.tsx
         - src/app/api/support/__tests__/tickets-feedback.test.ts
       Do NOT add a real send here; we are not the right surface to
       trigger a customer-facing email from CI. */

    /* ------------------------------------------------------------------ */
    /* Final settle window for async failures                              */
    /* ------------------------------------------------------------------ */
    await page.waitForTimeout(3_000);
    const collected = failures();
    expect(
      collected,
      `CSP / pageerror / 401 / 5xx failures during journey:\n${collected
        .map((f) => `  - [${f.kind}] ${f.detail}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
