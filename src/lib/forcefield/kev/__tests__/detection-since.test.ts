import { KEV_DETECTION_SINCE, exploitLead } from "../detection-since";
import { FORCEFIELD_KEV_CVES } from "@/lib/forcefield-web/kev-rules";

describe("when each known-exploited CVE became visible to Forcefield", () => {
  it("every CVE the rules reference has a detection date", () => {
    expect(FORCEFIELD_KEV_CVES.filter((c) => !KEV_DETECTION_SINCE[c])).toEqual([]);
    for (const d of Object.values(KEV_DETECTION_SINCE)) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("PHP2Shell: listed 2026-10-26, watched from that day, first probe the next day: 1 day, measured", () => {
    expect(exploitLead("CVE-2026-109618", "2026-10-26", "2026-10-27")).toEqual({ detectionSince: "2026-10-26", leadDays: 1, measured: true });
  });
  it("React2Shell: listed 2025-12-05, detection only from 2026-10-24: a lead time is not claimed", () => {
    const r = exploitLead("CVE-2025-55182", "2025-12-05", "2026-10-27");
    expect(r.measured).toBe(false);
    expect(r.detectionSince).toBe("2026-10-24");
  });
  it("missing dates give no lead time, never a wrong one", () => {
    expect(exploitLead("CVE-2026-109618", null, "2026-10-27")).toEqual({ detectionSince: "2026-10-26", leadDays: null, measured: false });
    expect(exploitLead("CVE-0000-0000", "2026-10-26", "2026-10-27").measured).toBe(false);
  });
});
