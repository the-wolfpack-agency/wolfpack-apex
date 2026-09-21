import { inspectInstinctRequest, fingerprintWeb } from "@/lib/forcefield-web/instinct-observe";

const base = { method: "GET", country: "US", nowMs: 1_758_000_000_000 };

describe("inspectInstinctRequest - Instinct self-defense (pure, monitor-only)", () => {
  it("returns null for a normal visitor (the common path forwards nothing)", () => {
    expect(inspectInstinctRequest({ ...base, path: "/dashboard", userAgent: "Mozilla/5.0 (Macintosh)" })).toBeNull();
  });

  it("welcomes a known good crawler", () => {
    const o = inspectInstinctRequest({ ...base, path: "/", userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1)" });
    expect(o?.type).toBe("site.agent_welcomed");
    expect(o?.props.agent).toBe("Googlebot");
    expect(o?.props.surface).toBe("instinct");
    expect(o?.props.blocked).toBe(false);
    expect(o?.props.posture).toBe("monitor");
  });

  it("flags self-declared automation not on the allowlist", () => {
    const o = inspectInstinctRequest({ ...base, path: "/", userAgent: "EvilScraper/9 (bot)" });
    expect(o?.type).toBe("site.agent_flagged");
    expect(o?.props.agent).toBe("unidentified");
  });

  it("records a decoy trip as the strongest signal", () => {
    const o = inspectInstinctRequest({ ...base, path: "/_ff/records", userAgent: "anything" });
    expect(o?.type).toBe("site.agent_trap_tripped");
    expect(o?.path).toBe("/_ff/records");
  });

  it("carries a stable per-session sig (same UA+country+hour clusters)", () => {
    const a = inspectInstinctRequest({ ...base, path: "/_ff/records", userAgent: "x" });
    const b = inspectInstinctRequest({ ...base, path: "/_ff/records", userAgent: "x" });
    expect(a?.props.sig).toBe(b?.props.sig);
    // a different hour bucket yields a different sig
    expect(fingerprintWeb("x", "US", base.nowMs)).not.toBe(fingerprintWeb("x", "US", base.nowMs + 3_600_000));
  });

  it("never emits a block decision - monitor-only by construction", () => {
    for (const ua of ["Googlebot", "EvilScraper/9 (bot)", "curl"]) {
      const o = inspectInstinctRequest({ ...base, path: "/_ff/records", userAgent: ua });
      expect(o?.props.blocked).toBe(false);
    }
  });
});
