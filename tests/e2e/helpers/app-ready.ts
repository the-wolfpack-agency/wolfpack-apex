/**
 * Readiness gate for the E2E suites.
 *
 * Why this exists: the reality-check + smoke suites run against a *preview*
 * deployment that is frequently still cold-booting when the workflow starts
 * probing it. A cold Vercel function can return 502/503/timeouts for the
 * first few seconds, and a Next.js route that has never been hit in this
 * deployment pays a one-time compile cost. The previous suites had NO
 * readiness check, so the first probe raced the boot and intermittently
 * failed with "text not found" / "element(s) not found" — failures that look
 * like product bugs but are pure readiness races.
 *
 * `waitForAppReady` polls a cheap, public, always-200 endpoint until the app
 * actually responds, then lets the real probes run. It does NOT weaken any
 * assertion — it only removes the race so a genuine failure is a genuine
 * failure.
 *
 * Endpoint choice: `/api/version` is the best target. It is public (no auth),
 * touches no DB and no secrets, is `force-dynamic` (so a 200 proves the
 * running function served it, not an edge/static cache), and is the same SHA
 * surface verify-deploy.sh already uses to confirm the alias advanced. If it
 * is ever removed, the GET of the login page is an equivalent fallback.
 *
 * Pure + injectable fetch so the polling/backoff/timeout logic is unit-
 * testable without a network or a real clock.
 */

/** Minimal fetch surface we depend on — keeps the unit test fake tiny. */
export type FetchLike = (
  url: string,
  init?: { method?: string; signal?: AbortSignal },
) => Promise<{ status: number }>;

export interface WaitForAppReadyOptions {
  /**
   * Path to poll. Must be a cheap, public, always-200 route. Defaults to the
   * public build-version endpoint.
   */
  readyPath?: string;
  /** HTTP statuses that count as "ready". Defaults to [200]. */
  acceptStatuses?: number[];
  /**
   * Total budget before giving up, in ms. A just-pushed preview can take a
   * little while to boot + compile the first route, so the default is
   * generous (60s) but bounded — the gate NEVER hangs forever.
   */
  timeoutMs?: number;
  /**
   * Base delay between polls, in ms. Backoff is linear: attempt N waits
   * `baseDelayMs * N` (capped at `maxDelayMs`) so early boots are caught
   * fast while a slow boot doesn't hammer the endpoint.
   */
  baseDelayMs?: number;
  /** Upper bound on a single inter-poll delay, in ms. */
  maxDelayMs?: number;
  /** Per-request timeout, in ms. A hung socket must not eat the whole budget. */
  perRequestTimeoutMs?: number;
  /** Injectable fetch (defaults to global fetch). */
  fetchImpl?: FetchLike;
  /** Injectable sleep (defaults to setTimeout). Unit tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (defaults to Date.now). Unit tests advance it manually. */
  now?: () => number;
  /** Optional logger (defaults to console.log). Pass () => {} to silence. */
  log?: (msg: string) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `<baseUrl><readyPath>` until it returns an acceptable status, or throw
 * a clear, actionable error once the bounded timeout elapses.
 *
 * Resolves with the number of attempts it took (useful for diagnostics/logs).
 */
export async function waitForAppReady(
  baseUrl: string,
  opts: WaitForAppReadyOptions = {},
): Promise<number> {
  const readyPath = opts.readyPath ?? "/api/version";
  const acceptStatuses = new Set(opts.acceptStatuses ?? [200]);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const baseDelayMs = opts.baseDelayMs ?? 1_000;
  const maxDelayMs = opts.maxDelayMs ?? 5_000;
  const perRequestTimeoutMs = opts.perRequestTimeoutMs ?? 10_000;
  const fetchImpl: FetchLike =
    opts.fetchImpl ?? ((url, init) => fetch(url, init) as Promise<{ status: number }>);
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((m: string) => console.log(m));

  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}${readyPath}`;
  const started = now();
  const deadline = started + timeoutMs;

  let attempt = 0;
  let lastStatus = 0;
  let lastError = "";

  // Loop while we still have budget. The check is at the top so a 0ms budget
  // makes exactly one attempt only when there is time for it — but we always
  // make at least one attempt so a healthy app is confirmed immediately.
  for (;;) {
    attempt += 1;
    try {
      // Per-request timeout via AbortSignal so a hung socket can't consume the
      // whole budget. AbortSignal.timeout is available in Node 18+ (CI uses 20).
      const signal =
        typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
          ? AbortSignal.timeout(perRequestTimeoutMs)
          : undefined;
      const res = await fetchImpl(url, { method: "GET", signal });
      lastStatus = res.status;
      if (acceptStatuses.has(res.status)) {
        log(
          `[app-ready] ${url} ready after ${attempt} attempt(s) ` +
            `(${now() - started}ms, status ${res.status})`,
        );
        return attempt;
      }
      lastError = `status ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    // Compute the next backoff, then only sleep if it still fits the budget.
    const delay = Math.min(baseDelayMs * attempt, maxDelayMs);
    if (now() + delay >= deadline) {
      break;
    }
    log(
      `[app-ready] ${url} not ready (attempt ${attempt}, ${lastError}); ` +
        `retrying in ${delay}ms`,
    );
    await sleep(delay);
  }

  throw new Error(
    `waitForAppReady: ${url} did not become ready within ${timeoutMs}ms ` +
      `(${attempt} attempt(s); last result: ${lastError || `status ${lastStatus}`}). ` +
      `The target deployment is unreachable or still cold-booting — this is a ` +
      `readiness/infra problem, not a product assertion failure.`,
  );
}
