/**
 * Contract tests for the spec-diff route: status codes and shapes, with the
 * engine, browser, store and SSRF guard mocked. The engine has its own unit
 * tests; what matters here is that the endpoint cannot be used as a request
 * forwarder, cannot run unauthenticated, and always leaves an audit trail.
 */
import { NextRequest, NextResponse } from "next/server";

const requireCapability = jest.fn();
const assertScannableUrl = jest.fn();
const runSpecDiff = jest.fn();
const saveSpecDiffRun = jest.fn();
const listSpecDiffRuns = jest.fn();
const trackEvent = jest.fn();
const recordAudit = jest.fn();
const closeBrowser = jest.fn();
const createSpecDiffBrowser = jest.fn();

class SsrfBlockedError extends Error {}

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => requireCapability(...a) }));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => recordAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "jest", requestId: "req-1" }),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => trackEvent(...a) }));
jest.mock("@/lib/platform-scan/ssrf-guard", () => ({
  assertScannableUrl: (...a: unknown[]) => assertScannableUrl(...a),
  SsrfBlockedError,
}));
jest.mock("@/lib/spec-diff/run", () => ({ runSpecDiff: (...a: unknown[]) => runSpecDiff(...a) }));
jest.mock("@/lib/spec-diff/store", () => ({
  saveSpecDiffRun: (...a: unknown[]) => saveSpecDiffRun(...a),
  listSpecDiffRuns: (...a: unknown[]) => listSpecDiffRuns(...a),
}));
jest.mock("@/lib/spec-diff/browser", () => ({ createSpecDiffBrowser: (...a: unknown[]) => createSpecDiffBrowser(...a) }));

import { GET, POST } from "@/app/api/admin/spec-diff/route";

const AUTHED = { ok: true, user: { id: "u1", role: "admin", workspaceId: "ws-1" } };

function req(method: string, body?: unknown, url = "http://localhost/api/admin/spec-diff") {
  return new NextRequest(url, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { "content-type": "application/json" },
  });
}

const CLEAN_RUN = {
  specUrl: "https://proto.test/dashboard.html",
  targetUrl: "https://app.test/admin",
  tolerancePx: 1.5,
  results: [],
  summary: { totalDiffs: 0, totalMissing: 0, fontMismatch: false, matchedElements: 40, clean: true, worstOffenders: [] },
  errors: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  requireCapability.mockResolvedValue(AUTHED);
  assertScannableUrl.mockResolvedValue(undefined);
  runSpecDiff.mockResolvedValue(CLEAN_RUN);
  saveSpecDiffRun.mockResolvedValue("run-1");
  listSpecDiffRuns.mockResolvedValue([]);
  createSpecDiffBrowser.mockResolvedValue({ browser: {}, hooks: {}, close: closeBrowser.mockResolvedValue(undefined) });
});

describe("auth", () => {
  it("POST refuses without the capability", async () => {
    // The real helper returns a ready-made response on failure, not a status code.
    requireCapability.mockResolvedValue({ ok: false, response: NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 }) });
    const res = await POST(req("POST", { specUrl: "https://a.test", targetUrl: "https://b.test" }));
    expect(res.status).toBe(403);
    expect(runSpecDiff).not.toHaveBeenCalled();
  });

  it("GET refuses without the capability", async () => {
    requireCapability.mockResolvedValue({ ok: false, response: NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }) });
    expect((await GET(req("GET"))).status).toBe(401);
  });
});

describe("input validation", () => {
  it("400s without both urls", async () => {
    expect((await POST(req("POST", { specUrl: "https://a.test" }))).status).toBe(400);
    expect((await POST(req("POST", {}))).status).toBe(400);
  });

  it("400s on a malformed body", async () => {
    const bad = new NextRequest("http://localhost/api/admin/spec-diff", { method: "POST", body: "not json", headers: { "content-type": "application/json" } });
    expect((await POST(bad)).status).toBe(400);
  });

  it("rejects absurd or empty viewport sets", async () => {
    const base = { specUrl: "https://a.test", targetUrl: "https://b.test" };
    expect((await POST(req("POST", { ...base, viewports: [] }))).status).toBe(400);
    expect((await POST(req("POST", { ...base, viewports: [{ width: 10, height: 10 }] }))).status).toBe(400);
    expect((await POST(req("POST", { ...base, viewports: Array(7).fill({ width: 1512, height: 950 }) }))).status).toBe(400);
    expect((await POST(req("POST", { ...base, viewports: [{ width: "wide", height: 950 }] }))).status).toBe(400);
  });

  it("defaults to a sane viewport set when none is given", async () => {
    await POST(req("POST", { specUrl: "https://a.test", targetUrl: "https://b.test" }));
    expect(runSpecDiff.mock.calls[0][0].viewports).toHaveLength(3);
  });
});

describe("SSRF", () => {
  it("blocks a url the guard rejects, and never opens a browser", async () => {
    assertScannableUrl.mockRejectedValueOnce(new SsrfBlockedError("private address"));
    const res = await POST(req("POST", { specUrl: "http://169.254.169.254/latest/meta-data", targetUrl: "https://b.test" }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining("blocked url") });
    expect(createSpecDiffBrowser).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith("spec_diff.blocked_url", "u1", "admin", expect.anything());
  });

  it("checks BOTH urls, not just the first", async () => {
    await POST(req("POST", { specUrl: "https://a.test", targetUrl: "https://b.test" }));
    expect(assertScannableUrl).toHaveBeenCalledTimes(2);
  });
});

describe("running a comparison", () => {
  it("returns the summary, persists the run and audits it", async () => {
    const res = await POST(req("POST", { specUrl: "https://proto.test/dashboard.html", targetUrl: "https://app.test/admin" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ runId: "run-1", summary: { clean: true } });

    expect(saveSpecDiffRun).toHaveBeenCalledWith("ws-1", CLEAN_RUN, expect.objectContaining({ createdBy: "u1" }));
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "spec_diff.run", resourceId: "run-1" }));
    expect(trackEvent).toHaveBeenCalledWith("spec_diff.completed", "u1", "admin", expect.objectContaining({ clean: true }));
  });

  it("scopes the stored run to the caller's workspace", async () => {
    requireCapability.mockResolvedValue({ ok: true, user: { id: "u9", role: "admin", workspaceId: "ws-other" } });
    await POST(req("POST", { specUrl: "https://a.test", targetUrl: "https://b.test" }));
    expect(saveSpecDiffRun.mock.calls[0][0]).toBe("ws-other");
  });

  it("502s when no browser is available, without pretending the pages matched", async () => {
    createSpecDiffBrowser.mockRejectedValueOnce(new Error("playwright missing"));
    const res = await POST(req("POST", { specUrl: "https://a.test", targetUrl: "https://b.test" }));
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: "browser_unavailable" });
    expect(saveSpecDiffRun).not.toHaveBeenCalled();
  });

  it("closes the browser even when the run throws", async () => {
    runSpecDiff.mockRejectedValueOnce(new Error("navigation failed"));
    const res = await POST(req("POST", { specUrl: "https://a.test", targetUrl: "https://b.test" }));
    expect(res.status).toBe(502);
    expect(closeBrowser).toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith("spec_diff.failed", "u1", "admin", expect.anything());
  });
});

describe("history", () => {
  it("lists this workspace's runs", async () => {
    listSpecDiffRuns.mockResolvedValue([{ id: "run-1", clean: false, total_diffs: 12 }]);
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ runs: [{ id: "run-1", total_diffs: 12 }] });
    expect(listSpecDiffRuns).toHaveBeenCalledWith("ws-1", 25);
  });
});
