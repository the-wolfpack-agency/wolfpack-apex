/**
 * Assessing a walked system's traffic.
 *
 * The detector, the declaration builder and the baseline are all tested in
 * anomaly/. What is tested here is the three things a WALK gets wrong if it
 * hands them the same inputs a single-page compliance scan does.
 */
import { assessWalkedTraffic } from "../assess";
import type { NetworkObservation } from "../../network/observations";

const ENTRY = "https://app.acme.example/org/home";

const obs = (url: string, atMs = 10): NetworkObservation => ({
  url,
  pageUrl: ENTRY,
  resourceType: "fetch",
  atMs,
  status: 200,
});

const base = {
  entryUrl: ENTRY,
  entryHeaders: { "content-security-policy": "default-src 'self'" } as Record<string, string> | null,
  trafficObserved: true,
  nowIso: "2026-08-30T00:00:00.000Z",
};

describe("consent, which a walk never asks about", () => {
  /* THE REASON THIS MODULE EXISTS. The walk signs in as an authorised user of
     an internal system. Reporting every host as firing before consent would be
     a claim about a question nobody asked. */
  it("does not stamp 'before consent' on hosts it never asked about", () => {
    const { report } = assessWalkedTraffic({
      ...base,
      observations: [obs("https://www.google-analytics.com/collect")],
    });
    expect(report.findings.every((f) => f.evidence.beforeConsent === false)).toBe(true);
  });

  /* Silence would read as consent having been obtained, which is the opposite
     of what happened. */
  it("says out loud that consent was not evaluated", () => {
    const { report } = assessWalkedTraffic({
      ...base,
      observations: [obs("https://www.google-analytics.com/collect")],
    });
    expect(report.caveats.join(" ")).toMatch(/not a finding that consent was obtained/i);
  });
});

describe("declarations from the entry page", () => {
  it("uses the captured policy to explain a host", () => {
    const { report } = assessWalkedTraffic({
      ...base,
      entryHeaders: { "content-security-policy": "default-src 'self' https://vendor.example" },
      observations: [obs("https://vendor.example/sdk.js")],
    });
    const vendor = report.findings.find((f) => f.host === "vendor.example");
    /* Declared and not new, so not raised as an anomaly at all. */
    expect(vendor?.explainedBy ?? null).not.toBeUndefined();
  });

  /* NOT CAPTURED IS NOT ABSENT. A report saying the system publishes no CSP
     when nobody looked is a false statement about a client's security posture. */
  it("does not claim the system lacks a policy when none was captured", () => {
    const { report } = assessWalkedTraffic({
      ...base,
      entryHeaders: null,
      observations: [obs("https://vendor.example/a")],
    });
    expect(report.caveats.join(" ")).toMatch(/Nothing here says the system lacks one/i);
  });
});

describe("the baseline, which makes a second walk worth more than the first", () => {
  it("folds this walk's hosts forward for next time", () => {
    const { nextBaseline, worthPersisting } = assessWalkedTraffic({
      ...base,
      observations: [obs("https://vendor.example/a")],
    });
    expect(worthPersisting).toBe(true);
    expect(nextBaseline.map((b) => b.host)).toContain("vendor.example");
  });

  it("calls a host new when the previous walk did not see it", () => {
    const { report } = assessWalkedTraffic({
      ...base,
      baseline: [
        { host: "known.example", firstSeenAt: base.nowIso, lastSeenAt: base.nowIso, scanCount: 3 },
      ],
      observations: [obs("https://newcomer.example/a")],
    });
    expect(report.findings.find((f) => f.host === "newcomer.example")?.novelty).toBe("new");
  });

  /* ONE FAILED RUN MUST NOT ERASE THE HISTORY that makes "this is new"
     answerable, or every host looks newly appeared on the next walk. */
  it("refuses to overwrite the baseline from a walk that saw nothing", () => {
    const previous = [
      { host: "known.example", firstSeenAt: base.nowIso, lastSeenAt: base.nowIso, scanCount: 3 },
    ];
    const { nextBaseline, worthPersisting } = assessWalkedTraffic({
      ...base,
      baseline: previous,
      observations: [],
    });
    expect(worthPersisting).toBe(false);
    expect(nextBaseline).toEqual(previous);
  });

  it("refuses just as firmly when the reader was not watching at all", () => {
    const { worthPersisting, report } = assessWalkedTraffic({
      ...base,
      trafficObserved: false,
      observations: [],
    });
    expect(worthPersisting).toBe(false);
    expect(report.caveats.join(" ")).toMatch(/gap in the scan rather than a system that contacts nobody/i);
  });
});

describe("a truncated recording", () => {
  it("says the list is a floor", () => {
    const { report } = assessWalkedTraffic({
      ...base,
      observations: [obs("https://vendor.example/a")],
      trafficTruncated: true,
    });
    expect(report.caveats.join(" ")).toMatch(/floor rather than a complete set/i);
  });
});
