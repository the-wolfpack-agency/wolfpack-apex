/**
 * Where the acceptance gate gets its browser.
 *
 * This is the fix for a bug nobody reported and nobody would have: the gate ran
 * on a ten-minute cron in production and degraded on every single run, because
 * chromium.launch() needs a binary a Vercel function does not have. It failed
 * CLEANLY, which is why it survived — a control that reports a tidy
 * "unavailable" forever looks healthier than one that crashes, and nobody
 * investigates a gate that never complains.
 *
 * Found by the route-runtime-capability guardrail, not by observation.
 */
import { specDiffBrowserSource, BrowserUnavailableError } from "../browser";

const ORIGINAL = process.env.BROWSER_WS_ENDPOINT;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.BROWSER_WS_ENDPOINT;
  else process.env.BROWSER_WS_ENDPOINT = ORIGINAL;
});

describe("specDiffBrowserSource", () => {
  it("uses the in-house browser pool when one is configured", () => {
    // Same env var and same infrastructure the screenshot tool already uses.
    // A second mechanism for the same job is a second thing to keep in step.
    process.env.BROWSER_WS_ENDPOINT = "ws://browsers.internal:3000";
    expect(specDiffBrowserSource()).toBe("remote-cdp");
  });

  it("falls back to launching locally when none is configured", () => {
    delete process.env.BROWSER_WS_ENDPOINT;
    expect(specDiffBrowserSource()).toBe("local-launch");
  });

  it("treats an empty value as not configured", () => {
    // An env var set to "" is the shape a half-finished deployment leaves
    // behind, and connecting to "" fails in a much more confusing way.
    process.env.BROWSER_WS_ENDPOINT = "";
    expect(specDiffBrowserSource()).toBe("local-launch");
  });
});

describe("BrowserUnavailableError", () => {
  it("records which source failed, so the fix is obvious from the message", () => {
    // "no browser" on local-launch means a missing binary; on remote-cdp it
    // means the pool is unreachable. Different problems, different people.
    const err = new BrowserUnavailableError("remote-cdp", new Error("ECONNREFUSED"));
    expect(err.source).toBe("remote-cdp");
    expect(err.message).toMatch(/remote-cdp/);
    expect(err.message).toMatch(/ECONNREFUSED/);
  });

  it("carries a stable name, because callers match on it rather than instanceof", () => {
    // Next can load a module in more than one bundle, and a jest.mock that
    // omits the class makes instanceof throw outright. The name survives both.
    expect(new BrowserUnavailableError("local-launch", "x").name).toBe("BrowserUnavailableError");
  });

  it("is an Error, so it still behaves in a catch and keeps a stack", () => {
    expect(new BrowserUnavailableError("local-launch", "x")).toBeInstanceOf(Error);
  });
});
