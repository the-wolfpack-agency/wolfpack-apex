/**
 * One fetch double, modelled on what fetch ACTUALLY does.
 *
 * This exists because hand-rolled fetch fakes have now caused three bugs in
 * three pull requests, and every one of them had the same shape: the fake
 * modelled the contract wrongly, the code was written against the same wrong
 * understanding, and the tests agreed with the bug.
 *
 *   #222  headers was modelled as a PROPERTY. Playwright's Response exposes
 *         headers() as a method, so the production path was broken while the
 *         tests passed. tsc caught it, not the suite.
 *
 *   #224  `ok` was computed as status < 400, so the fake called a 302 "ok".
 *         Real fetch sets ok for 2xx ONLY.
 *
 *   #224  the fake registered an abort listener and waited. A signal that is
 *         ALREADY aborted never fires a listener, so the promise never settled
 *         and the test hung in CI for 5 seconds and failed. Real fetch rejects
 *         immediately when handed an aborted signal.
 *
 * The rules encoded here, each of which a hand-rolled fake got wrong:
 *
 *   - `ok` is true for 2xx and NOTHING else.
 *   - An already-aborted signal rejects immediately with an AbortError.
 *   - Aborting later rejects a pending request with an AbortError.
 *   - `headers` is a real Headers instance, so `.get()` is case-insensitive
 *     the way a caller expects.
 *   - `redirect: "manual"` is honoured by simply returning the 3xx: this fake
 *     never follows anything, so a caller that relies on the fetch layer to
 *     follow redirects will visibly fail rather than quietly pass.
 *
 * Not a test file itself — jest's testMatch only collects *.test.ts.
 */

export interface FakeResponseSpec {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Overrides the requested URL on the response, for the rare caller that
   *  reads res.url. Defaults to the URL actually requested. */
  url?: string;
}

/** A 3xx with a Location, for exercising a redirect chain. */
export function redirectTo(location: string, status = 302): FakeResponseSpec {
  return { status, headers: { location }, body: "" };
}

/** A plain 200 with an HTML body. */
export function htmlResponse(body: string, headers: Record<string, string> = {}): FakeResponseSpec {
  return { status: 200, headers, body };
}

class FakeAbortError extends Error {
  constructor() {
    super("The operation was aborted.");
    this.name = "AbortError";
  }
}

function buildResponse(spec: FakeResponseSpec, requestedUrl: string) {
  const status = spec.status ?? 200;
  return {
    // 2xx and nothing else. A fake that calls a 302 "ok" teaches the code the
    // wrong thing and then agrees with it.
    ok: status >= 200 && status < 300,
    status,
    url: spec.url ?? requestedUrl,
    headers: new Headers(spec.headers ?? {}),
    text: async () => spec.body ?? "",
    json: async () => JSON.parse(spec.body ?? "null"),
  };
}

export interface FakeFetchOptions {
  /** Never settle, so a caller's own timeout is what ends the request. Used to
   *  test timeout handling. The abort contract is still honoured. */
  hang?: boolean;
  /** Throw this instead of responding, for network-failure paths. */
  throws?: Error;
}

/**
 * Serves each spec in order; the last one repeats.
 *
 * Returns a jest.fn so callers can assert on the requests that were made — the
 * URL sequence through a redirect chain, or that `redirect: "manual"` was
 * actually asked for.
 */
export function fakeFetch(
  specs: FakeResponseSpec[] | FakeResponseSpec,
  options: FakeFetchOptions = {},
): jest.Mock & typeof fetch {
  const list = Array.isArray(specs) ? specs : [specs];
  let i = 0;

  const fn = jest.fn(async (url: string, init: RequestInit = {}) => {
    const signal = init.signal ?? undefined;

    // Real fetch rejects straight away when handed a signal that is already
    // aborted. It does NOT wait for an abort event that has already happened.
    if (signal?.aborted) throw new FakeAbortError();

    if (options.throws) throw options.throws;

    if (options.hang) {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new FakeAbortError()), { once: true });
      });
    }

    const spec = list[Math.min(i++, list.length - 1)];
    return buildResponse(spec, url);
  });

  return fn as unknown as jest.Mock & typeof fetch;
}
