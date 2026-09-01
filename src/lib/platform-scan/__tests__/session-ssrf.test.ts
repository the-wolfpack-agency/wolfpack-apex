/**
 * A scanner that can be pointed at cloud metadata is not a scanner.
 *
 * FLAGGED BY CODEQL AS js/request-forgery, CRITICAL, AND IT WAS RIGHT. The
 * login path built its URL from a caller-supplied baseUrl and fetched it. That
 * is the feature: platform-scan exists to log into a target somebody names.
 * Fetching http://169.254.169.254/ or a database on localhost is not.
 *
 * THE GUARD ALREADY EXISTED. assertScannableUrl is used by eight other modules
 * and this path went straight past it, which is the argument for checking
 * inside the function rather than at the caller: a guard somebody has to
 * remember to call is exactly the state this was already in.
 *
 * These assert the request NEVER LEAVES, not merely that the call returns
 * null. establishSession answers null for every failure, so a test that only
 * checked the return value would pass just as happily if the fetch had gone
 * out and failed.
 */

import { establishSession } from "@/lib/platform-scan/session";

function spyFetch() {
  const calls: string[] = [];
  const impl = (async (url: unknown) => {
    calls.push(String(url));
    throw new Error("network reached");
  }) as never;
  return { calls, impl };
}

async function attempt(baseUrl: string) {
  const spy = spyFetch();
  const result = await establishSession({
    baseUrl,
    loginPath: "/login",
    username: "u",
    password: "p",
    fetchImpl: spy.impl,
  });
  return { result, reached: spy.calls.length > 0 };
}

describe("internal targets are refused before any request goes out", () => {
  it.each([
    ["cloud metadata", "http://169.254.169.254"],
    ["link-local by name", "http://metadata.google.internal"],
    ["loopback", "http://127.0.0.1"],
    ["loopback by name", "http://localhost:5432"],
    ["IPv6 loopback", "http://[::1]"],
    ["private range", "http://10.0.0.5"],
    ["private range 192.168", "http://192.168.1.1"],
    ["an .internal host", "http://db.internal"],
  ])("refuses %s without reaching the network", async (_label, baseUrl) => {
    const { result, reached } = await attempt(baseUrl);
    expect(reached).toBe(false);
    expect(result).toBeNull();
  });

  /* A scheme that is not http(s) has no business here at all. */
  it("refuses a non-http scheme", async () => {
    const { reached } = await attempt("file:///etc/passwd");
    expect(reached).toBe(false);
  });
});

/**
 * AND IT MUST NOT BREAK THE PRODUCT. Refusing everything would pass every
 * test above and make the scanner useless, which is the failure mode a
 * security fix is most likely to ship.
 */
describe("real targets still work", () => {
  it("lets a public host through to the network", async () => {
    const { reached } = await attempt("https://example.com");
    expect(reached).toBe(true);
  });

  it("builds the URL from baseUrl and loginPath as before", async () => {
    const spy = spyFetch();
    await establishSession({
      baseUrl: "https://example.com",
      loginPath: "/api/auth/login",
      username: "u",
      password: "p",
      fetchImpl: spy.impl,
    });
    expect(spy.calls[0]).toBe("https://example.com/api/auth/login");
  });
});
