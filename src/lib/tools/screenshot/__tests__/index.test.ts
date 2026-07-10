/**
 * captureScreenshot: the SSRF guard runs BEFORE any engine, and the engine is
 * selected by BROWSER_WS_ENDPOINT. A fake provider stands in for the browser so
 * these tests never launch Chromium.
 */

import {
  captureScreenshot,
  getScreenshotProvider,
} from "@/lib/tools/screenshot";
import type { ScreenshotProvider } from "@/lib/tools/screenshot";

function fakeProvider(): ScreenshotProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "fake",
    calls,
    async capture(req) {
      calls.push(req.url);
      return { ok: true, png: Buffer.from("PNG") };
    },
  };
}

describe("captureScreenshot SSRF guard", () => {
  it("blocks a loopback URL and never reaches the engine", async () => {
    const p = fakeProvider();
    const r = await captureScreenshot({ url: "http://127.0.0.1/admin" }, p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ssrf_blocked");
    expect(p.calls).toEqual([]); // engine never ran
  });

  it("blocks localhost", async () => {
    const p = fakeProvider();
    const r = await captureScreenshot({ url: "http://localhost:3000/" }, p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ssrf_blocked");
    expect(p.calls).toEqual([]);
  });

  it("passes a public host through to the engine", async () => {
    const p = fakeProvider();
    // A public IP literal avoids a real DNS lookup in the test.
    const r = await captureScreenshot({ url: "http://8.8.8.8/" }, p);
    expect(r.ok).toBe(true);
    expect(p.calls).toEqual(["http://8.8.8.8/"]);
  });
});

describe("getScreenshotProvider selection", () => {
  const original = process.env.BROWSER_WS_ENDPOINT;
  afterEach(() => {
    if (original === undefined) delete process.env.BROWSER_WS_ENDPOINT;
    else process.env.BROWSER_WS_ENDPOINT = original;
  });

  it("uses serverless Chromium by default", () => {
    delete process.env.BROWSER_WS_ENDPOINT;
    expect(getScreenshotProvider().name).toBe("serverless-chromium");
  });

  it("uses the in-house browser pool when BROWSER_WS_ENDPOINT is set", () => {
    process.env.BROWSER_WS_ENDPOINT = "ws://browser.internal:3000";
    expect(getScreenshotProvider().name).toBe("remote-cdp");
  });
});
