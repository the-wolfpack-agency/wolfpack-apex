/**
 * The click-and-go scan, end to end.
 *
 * Two things are load-bearing and both are about refusing to overclaim:
 *
 *   1. The gate is asked FIRST and its refusal is final. A scan that fetches
 *      the site and then asks permission has already done the thing.
 *   2. The static tier cannot report ABSENT for anything it is not equipped to
 *      see. Without that rule, a scan that simply used the wrong instrument
 *      produces a confident, wrong, client-facing claim.
 */
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import { runSiteScan, downgradeForTier, type ScanTier } from "../run";
import type { ComplianceFinding } from "../findings";

const PAGE = "https://client.example.com/";
const ACTOR = { userId: "u1", role: "admin" };

const ALLOW = jest.fn(async () => ({ allowed: true as const, decision: {} as never }));

function fetchHtml(html: string, headers: Record<string, string> = {}) {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    url: PAGE,
    headers: new Headers(headers),
    text: async () => html,
  })) as unknown as typeof fetch;
}

function baseInput() {
  return { workspaceId: "ws", platform: "client-site", pageUrl: PAGE, actor: ACTOR };
}

function baseDeps(html: string, headers: Record<string, string> = {}) {
  return {
    authorize: ALLOW as never,
    staticDeps: { fetchImpl: fetchHtml(html, headers) },
    readBaseline: jest.fn(async () => [] as never) as never,
    record: jest.fn(async () => ({ runId: "run-1", baselineUpdated: true })) as never,
  };
}

beforeEach(() => jest.clearAllMocks());

describe("the gate", () => {
  it("is asked before anything is fetched", async () => {
    const order: string[] = [];
    const authorize = jest.fn(async () => {
      order.push("authorize");
      return { allowed: true as const, decision: {} as never };
    });
    const fetchImpl = jest.fn(async () => {
      order.push("fetch");
      return { ok: true, status: 200, url: PAGE, headers: new Headers(), text: async () => "<html></html>" };
    }) as unknown as typeof fetch;

    await runSiteScan(baseInput(), {
      authorize: authorize as never,
      staticDeps: { fetchImpl },
      readBaseline: jest.fn(async () => []) as never,
      record: jest.fn(async () => ({ runId: "r", baselineUpdated: true })) as never,
    });
    expect(order).toEqual(["authorize", "fetch"]);
  });

  it("refuses without touching the site when the gate says no", async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const res = await runSiteScan(baseInput(), {
      authorize: jest.fn(async () => ({ allowed: false as const, reason: "target_not_verified" })) as never,
      staticDeps: { fetchImpl },
    });
    expect(res).toEqual({ ok: false, reason: "target_not_verified" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("proposes a READ-ONLY navigate, never a mutating action", async () => {
    const authorize = jest.fn(async (_input: unknown) => ({ allowed: true as const, decision: {} as never }));
    await runSiteScan(baseInput(), {
      authorize: authorize as never,
      staticDeps: { fetchImpl: fetchHtml("<html></html>") },
      readBaseline: jest.fn(async () => []) as never,
      record: jest.fn(async () => ({ runId: "r", baselineUpdated: true })) as never,
    });
    expect(authorize.mock.calls[0][0]).toMatchObject({
      workspaceId: "ws",
      action: { kind: "navigate", targetUrl: PAGE, platform: "client-site" },
    });
  });
});

describe("tier honesty", () => {
  it("downgrades an ABSENT consent finding on the static tier", () => {
    // Most consent platforms inject their banner with JavaScript, so its
    // absence from served HTML says nothing at all.
    const findings: ComplianceFinding[] = [
      { id: "cookie-consent", title: "No consent mechanism found", verdict: "absent", severity: "critical", detail: "Nothing was found." },
    ];
    const [out] = downgradeForTier(findings, "static");
    expect(out.verdict).toBe("unverifiable");
    expect(out.detail).toMatch(/needs a browser-backed scan/);
    expect(out.evidence).toMatchObject({ downgradedFrom: "absent" });
  });

  it("leaves a PRESENT verdict alone", () => {
    // Positive evidence found with a weaker instrument is still found.
    const findings: ComplianceFinding[] = [
      { id: "cookie-consent", title: "Consent platform detected", verdict: "present", severity: "info", detail: "Found." },
    ];
    expect(downgradeForTier(findings, "static")[0].verdict).toBe("present");
  });

  it("leaves findings the static tier CAN answer alone", () => {
    // A missing privacy policy link is missing from the served HTML. That is a
    // real answer, and softening it would make the report useless.
    const findings: ComplianceFinding[] = [
      { id: "privacy-policy", title: "No privacy policy linked", verdict: "absent", severity: "high", detail: "No link found." },
    ];
    expect(downgradeForTier(findings, "static")[0].verdict).toBe("absent");
  });

  it("downgrades nothing on the browser tier", () => {
    const findings: ComplianceFinding[] = [
      { id: "cookie-consent", title: "No consent mechanism found", verdict: "absent", severity: "critical", detail: "Nothing." },
    ];
    expect(downgradeForTier(findings, "browser" as ScanTier)[0].verdict).toBe("absent");
  });

  it("says in the report that a static scan cannot see script-injected trackers", async () => {
    const res = await runSiteScan(baseInput(), baseDeps("<html><body></body></html>"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report.tier).toBe("static");
    expect(res.report.anomaly.caveats.join(" ")).toMatch(/added later by another script/);
  });
});

describe("the report", () => {
  it("produces findings and a summary for a real-looking page", async () => {
    const html = `<html lang="en"><head><title>Acme</title>
      <script src="https://hotjar.com/hj.js"></script></head>
      <body><a href="/privacy">Privacy Policy</a><a href="/contact">Contact</a></body></html>`;
    const res = await runSiteScan(baseInput(), baseDeps(html));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report.summary.total).toBeGreaterThan(0);
    expect(res.report.findings.find((f) => f.id === "privacy-policy")?.verdict).toBe("present");
    // Unexplained: the page has no CSP permitting hotjar.
    expect(res.report.anomaly.findings.some((f) => f.host === "hotjar.com")).toBe(true);
  });

  it("uses the site's own CSP to explain its traffic", async () => {
    const html = '<script src="https://plausible.io/s.js"></script>';
    const res = await runSiteScan(baseInput(), baseDeps(html, { "content-security-policy": "script-src https://plausible.io" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report.anomaly.totals.unexplained).toBe(0);
  });

  it("still returns a report when the site is down", async () => {
    // A report that says what it could not establish is useful. A thrown error
    // is not.
    const failing = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await runSiteScan(baseInput(), { ...baseDeps(""), staticDeps: { fetchImpl: failing } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report.error).toBe("ECONNREFUSED");
    expect(res.report.findings.every((f) => f.verdict === "unverifiable")).toBe(true);
    expect(res.report.summary.absent).toBe(0);
  });

  it("names the URL it actually landed on after a redirect", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      url: "https://www.elsewhere.example.org/",
      headers: new Headers(),
      text: async () => "<html></html>",
    })) as unknown as typeof fetch;
    const res = await runSiteScan(baseInput(), { ...baseDeps(""), staticDeps: { fetchImpl } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report.pageUrl).toBe(PAGE);
    expect(res.report.finalUrl).toBe("https://www.elsewhere.example.org/");
  });
});

describe("persistence", () => {
  it("records the run and reports whether the baseline moved", async () => {
    const record = jest.fn(async (_args: { workspaceId: string; targetId: string; actor: unknown }) => ({ runId: "run-7", baselineUpdated: true }));
    const res = await runSiteScan(baseInput(), { ...baseDeps("<html></html>"), record: record as never });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report.runId).toBe("run-7");
    expect(res.report.baselineUpdated).toBe(true);
    expect(record.mock.calls[0][0]).toMatchObject({ workspaceId: "ws", targetId: "client-site" });
  });

  it("still returns findings when the run cannot be saved", async () => {
    // Losing the client's report because a write failed is the worse outcome.
    const record = jest.fn(async () => {
      throw new Error("db down");
    });
    const res = await runSiteScan(baseInput(), { ...baseDeps("<html></html>"), record: record as never });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report.runId).toBeNull();
    expect(res.report.anomaly.caveats.join(" ")).toMatch(/could not be saved/);
  });

  it("does not write at all when persist is false", async () => {
    const record = jest.fn();
    await runSiteScan(baseInput(), { ...baseDeps("<html></html>"), record: record as never, persist: false });
    expect(record).not.toHaveBeenCalled();
  });

  it("distinguishes an UNREADABLE baseline from a first scan", async () => {
    // Both look like "no baseline". Treating a broken read as a first scan
    // would make everything look non-novel forever, silently.
    const readBaseline = jest.fn(async () => {
      throw new Error("db down");
    });
    const res = await runSiteScan(baseInput(), { ...baseDeps("<html></html>"), readBaseline: readBaseline as never });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report.anomaly.caveats.join(" ")).toMatch(/system fault, not a finding about the site/);
  });

  it("passes the actor through, so the run is attributed to a person", async () => {
    const record = jest.fn(async (_args: { actor: unknown }) => ({ runId: "r", baselineUpdated: true }));
    await runSiteScan(baseInput(), { ...baseDeps("<html></html>"), record: record as never });
    expect(record.mock.calls[0][0].actor).toEqual(ACTOR);
  });
});
