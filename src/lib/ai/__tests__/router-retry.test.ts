/**
 * A blip must not reach a person.
 *
 * WHAT WAS MISSING. The router had no retry at all: one transient failure and
 * the turn was lost. Worse, `isRetryableError` did not count 429, which is the
 * most common failure a hosted model produces and the most retryable thing
 * there is, since the request was fine and the service was merely busy. So the
 * single likeliest outage produced neither a retry nor a failover, and
 * somebody saw a dead end for a condition that usually clears in under a
 * second.
 *
 * Raw network errors were missed too. The three SDK class names it checked
 * only appear when the SDK made the call; a fetch that cannot open a socket
 * throws a plain Error carrying ECONNREFUSED, and that was classed as
 * permanent.
 *
 * WHAT IS DELIBERATELY NOT RETRIED. Ordinary 4xx. A malformed request fails
 * identically the second time, and retrying spends money twice to arrive in
 * the same place.
 */

import { isRetryableError, retryDelayMs } from "@/lib/ai/router";

describe("what counts as worth trying again", () => {
  it.each([
    ["a 429 throttle, the common case", { status: 429 }],
    ["a 408 timeout", { status: 408 }],
    ["a 500", { status: 500 }],
    ["a 503", { status: 503 }],
    ["a named rate-limit error", { name: "RateLimitError" }],
    ["an SDK connection error", { name: "APIConnectionError" }],
    ["an aborted call", { name: "AbortError" }],
    ["a refused socket", { code: "ECONNREFUSED" }],
    ["a reset connection", { code: "ECONNRESET" }],
    ["DNS not resolving yet", { code: "EAI_AGAIN" }],
    ["a fetch wrapping the syscall", { cause: { code: "ECONNREFUSED" } }],
  ])("retries %s", (_label, err) => {
    expect(isRetryableError(err)).toBe(true);
  });

  it.each([
    ["a bad request", { status: 400 }],
    ["an auth failure", { status: 401 }],
    ["a forbidden call", { status: 403 }],
    ["a content filter rejection", { status: 422 }],
    ["a plain error with no signal", new Error("something went wrong")],
    ["a null", null],
    ["a string", "boom"],
  ])("does not retry %s", (_label, err) => {
    expect(isRetryableError(err)).toBe(false);
  });

  /* 404 has its own handling: a named-but-absent deployment degrades a tier
     rather than retrying, which is already covered elsewhere. It must not be
     swept into the generic retry, or a permanently missing model would be
     called twice on every single turn. */
  it("does not treat a missing deployment as a generic retry", () => {
    expect(isRetryableError({ status: 404 })).toBe(false);
  });
});

describe("how long it waits", () => {
  it("honours Retry-After when the service sends one", () => {
    expect(retryDelayMs({ status: 429, headers: { "retry-after": "1" } }, 1)).toBe(1000);
  });

  /* A provider asking for thirty seconds is telling us to use a different one,
     not to leave somebody staring at a spinner. */
  it("caps a long Retry-After rather than making a person wait", () => {
    expect(retryDelayMs({ status: 429, headers: { "retry-after": "30" } }, 1)).toBeLessThanOrEqual(
      1500,
    );
  });

  it("backs off when no hint is given, and stays bounded", () => {
    const first = retryDelayMs({ status: 500 }, 1);
    const second = retryDelayMs({ status: 500 }, 2);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThanOrEqual(1500);
  });

  it("ignores a nonsense Retry-After instead of trusting it", () => {
    for (const bad of ["soon", "-5", "", null, undefined, NaN]) {
      const d = retryDelayMs({ status: 429, headers: { "retry-after": bad } }, 1);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(1500);
    }
  });
});
