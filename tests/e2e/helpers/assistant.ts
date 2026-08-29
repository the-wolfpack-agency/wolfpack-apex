/**
 * Driving the assistant in a browser. Written once, because writing it again is
 * how the last six versions each got a different thing wrong.
 *
 * EVERY ONE OF THESE COST A WRONG NUMBER REPORTED AS A FINDING:
 *
 *   Reading document.body.textContent
 *     A Next.js page carries the RSC flight payload in the DOM, so the "answer"
 *     was megabytes of framework JSON and the growth check never fired. Four
 *     prompts reported as 90-second timeouts; none of them had timed out.
 *
 *   Pressing Enter
 *     The composer's own hint says Cmd+Enter. Enter inserts a newline, so
 *     nothing was ever sent and three more prompts read as timeouts.
 *
 *   Waiting for ONE new message
 *     The question and the reply share the same testid prefix, so the wait
 *     resolved the instant the user's own message rendered. Timings came back
 *     as 10ms, 12ms, 24ms, and one assertion was handed the question as if it
 *     were the answer.
 *
 *   Reading the answer immediately
 *     Streaming was still in flight, so the classifier judged half a sentence.
 *
 * None of those is exotic. Each is a five-minute mistake that produced
 * confident, plausible, wrong output, and the cost was not the five minutes.
 */
import { expect, type Page } from "@playwright/test";

/** Question and reply carry the same prefix, which is why turns count TWO. */
export const MESSAGE_SELECTOR = '[data-testid^="assistant-msg-content-"]';

const COMPOSER =
  'input[placeholder*="Ask anything"], textarea[placeholder*="Ask anything"]';

/** Let a streaming answer finish before anything reads it. */
const SETTLE_MS = 2_000;

export interface Turn {
  /** Null when nothing arrived inside the budget. */
  latencyMs: number | null;
  answer: string;
}

/**
 * Sign in and wait for the app, not for a navigation event.
 *
 * waitForURL resolves on a navigation until "load". The app routes client-side
 * after login, so that event may never arrive though the person is signed in
 * and looking at the composer. It failed once in eight logins against
 * production and passed on retry, which is the signature of waiting on the
 * wrong signal rather than of a real fault.
 */
export async function signIn(
  page: Page,
  baseUrl: string,
  email: string,
  password: string,
): Promise<void> {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[type="email"], input[name="email"]').first().fill(email);
  await page.locator('input[type="password"], input[name="password"]').first().fill(password);

  const submit = page.locator('button[type="submit"]').first();
  /* Enabled only once hydrated: a click before then does a native GET submit
     and no POST ever happens, which this repo has already diagnosed once as
     the real cause of a flaky login. */
  await expect(submit).toBeEnabled({ timeout: 20_000 });
  await submit.click();

  /* ANY, NOT RACE. Promise.race settles on the first result INCLUDING a
     rejection, so a slow waitForURL killed the whole wait even when the
     composer was about to appear. That is not hypothetical: it failed once in
     a thirteen-test run against production and passed on retry, which is what
     a wrong wait looks like from the outside.
     
     Promise.any rejects only if BOTH signals fail, which is the actual
     question: is the app there by either measure. */
  await Promise.any([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 45_000 }),
    page.locator(`${COMPOSER}, nav, aside`).first().waitFor({ state: "visible", timeout: 45_000 }),
  ]);
}

/** Open a fresh conversation, dismissing the first-run modal if it is up. */
export async function openAssistant(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/assistant`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => undefined);
  /* Escape closes it as of 2026-08-29; before that only a click outside did,
     which is why earlier screenshots all had a panel over the answer. */
  await page.keyboard.press("Escape").catch(() => undefined);
}

/**
 * Ask one question and return the reply.
 *
 * Counts messages BEFORE sending and waits for TWO more, because the question
 * and the reply both render with the same testid.
 */
export async function ask(page: Page, text: string, budgetMs: number): Promise<Turn> {
  const input = page.locator(COMPOSER).first();
  await input.waitFor({ state: "visible", timeout: 20_000 });

  const before = await page.locator(MESSAGE_SELECTOR).count();
  await input.fill(text);
  const started = Date.now();
  /* Cmd+Enter, per the composer's own hint. */
  await input.press("Meta+Enter");

  try {
    await page.waitForFunction(
      ({ sel, n }) => document.querySelectorAll(sel).length >= n + 2,
      { sel: MESSAGE_SELECTOR, n: before },
      { timeout: budgetMs + 20_000 },
    );
  } catch {
    return { latencyMs: null, answer: "" };
  }

  const latencyMs = Date.now() - started;
  await page.waitForTimeout(SETTLE_MS);
  /* The LAST message, which is the reply: .first() would return the opening
     greeting on a fresh conversation. */
  return { latencyMs, answer: (await page.locator(MESSAGE_SELECTOR).last().textContent()) ?? "" };
}

/** Whitespace-collapsed, for classifying and for printing. */
export function flatten(answer: string): string {
  return answer.replace(/\s+/g, " ").trim();
}
