import { matchProbePath, summarizeProbeIntel, PROBE_SIGNATURES } from "@/lib/agent-probe-signatures";

describe("probe signatures (reused AgenticQA knowledge)", () => {
  it("names the specific exposure for a probed path, most-specific-first", () => {
    expect(matchProbePath("/actuator/env")?.label).toMatch(/environment variables/i);
    expect(matchProbePath("/actuator/env")?.severity).toBe("critical");
    expect(matchProbePath("/actuator/health")?.label).toMatch(/Actuator exposed/i); // falls back to /actuator
    expect(matchProbePath("/.env")?.cwe).toBe("CWE-200");
    expect(matchProbePath("/latest/meta-data/iam")?.cwe).toBe("CWE-918"); // cloud metadata SSRF
    expect(matchProbePath("/.git/config")?.category).toBe("secrets-exposure");
  });

  it("is case-insensitive and ignores the query string", () => {
    expect(matchProbePath("/WP-LOGIN.PHP?redirect=1")?.category).toBe("admin-surface");
  });

  it("returns null for a benign path", () => {
    expect(matchProbePath("/pricing")).toBeNull();
    expect(matchProbePath("/")).toBeNull();
  });

  it("aggregates + ranks by severity then frequency", () => {
    const intel = summarizeProbeIntel(["/admin", "/admin", "/.env", "/latest/meta-data/", "/pricing"]);
    // critical (metadata SSRF, .env) rank above medium (/admin), even though /admin is more frequent
    expect(intel[0].severity).toBe("critical");
    const admin = intel.find((e) => e.label.match(/admin surface/i));
    expect(admin?.count).toBe(2);
    // benign path contributes nothing
    expect(intel.reduce((n, e) => n + e.count, 0)).toBe(4);
  });

  it("covers every path in this repo's SENSITIVE_PROBE_PATHS (parity with the flag)", async () => {
    const { SENSITIVE_PROBE_PATHS } = await import("@/lib/agent-probe");
    for (const p of SENSITIVE_PROBE_PATHS) expect(matchProbePath(p)).not.toBeNull(); // every flagged path has a named signature
  });

  it("severities are from the known set", () => {
    for (const s of PROBE_SIGNATURES) expect(["low", "medium", "high", "critical"]).toContain(s.severity);
  });
});
