/**
 * The security-control mapping is what lets the deep audits feed a compliance
 * report, so its honesty is tested directly: a finding becomes a framework GAP, an
 * assessed-but-clean category reads "checked_clear" (not "met"), an UNassessed
 * category reads "not_assessed" (never silently met), and Forcefield marks an
 * attack class it blocks as "compensated" rather than hiding the code gap.
 */
import { assessSecurityControls, OWASP_TOP_10_2021 } from "../security-controls";

const find = (title: string, category = "security") => ({ title, category, severity: "high" });
const status = (r: ReturnType<typeof assessSecurityControls>, owaspId: string) =>
  r.assessments.find((a) => a.owasp.id === owaspId)!;

it("maps a SQL injection finding to A03 Injection as a gap", () => {
  const r = assessSecurityControls([find("SQL injection: value interpolated into a query string")]);
  const a03 = status(r, "A03:2021");
  expect(a03.status).toBe("gap");
  expect(a03.cwes).toContain("CWE-89");
  expect(a03.findingCount).toBe(1);
});

it("maps an IDOR finding to A01 Broken Access Control", () => {
  const r = assessSecurityControls([find("Object looked up by id with no ownership scope (IDOR)")]);
  expect(status(r, "A01:2021").status).toBe("gap");
  expect(status(r, "A01:2021").cwes).toContain("CWE-639");
});

it("marks an injection class as COMPENSATED when Forcefield is active (code gap still noted)", () => {
  const r = assessSecurityControls([find("XSS risk: dangerouslySetInnerHTML")], { forcefieldActive: true });
  const a03 = status(r, "A03:2021");
  expect(a03.status).toBe("compensated");
  expect(a03.findingCount).toBe(1); // the code finding is NOT hidden
  expect(a03.detail).toMatch(/Forcefield/);
});

it("does NOT compensate a class Forcefield cannot block (missing authorization) even when active", () => {
  const r = assessSecurityControls([find("Sensitive route with no visible authorization check")], { forcefieldActive: true });
  expect(status(r, "A01:2021").status).toBe("gap");
});

it("an assessed category with no findings is checked_clear, not 'met'", () => {
  const r = assessSecurityControls([]);
  const a03 = status(r, "A03:2021");
  expect(a03.status).toBe("checked_clear");
  expect(a03.detail).toMatch(/not a proof/i);
});

it("a category the scanner does not cover is not_assessed (never silently met)", () => {
  // A06 Vulnerable/Outdated Components has no detector mapping.
  const r = assessSecurityControls([]);
  expect(status(r, "A06:2021").status).toBe("not_assessed");
  expect(status(r, "A06:2021").detail).toMatch(/not evidence of compliance/i);
});

it("ignores non-security findings (a bug is not a control gap)", () => {
  const r = assessSecurityControls([{ title: "fetch result used without an ok/status check", category: "bug" }]);
  expect(r.summary.gap).toBe(0);
});

it("assessedOwaspIds: a category OUTSIDE the assessed set is not_assessed, not checked_clear", () => {
  // A live scan that assessed only A05 (headers) must not claim A03 is clean.
  const r = assessSecurityControls([], { assessedOwaspIds: ["A05:2021"] });
  expect(status(r, "A05:2021").status).toBe("checked_clear");
  expect(status(r, "A03:2021").status).toBe("not_assessed");
  expect(status(r, "A01:2021").status).toBe("not_assessed");
});

it("maps a missing-security-headers finding to A05 (the live-scan path)", () => {
  const r = assessSecurityControls(
    [find("Security misconfiguration: core security headers missing")],
    { assessedOwaspIds: ["A05:2021"] },
  );
  expect(status(r, "A05:2021").status).toBe("gap");
  expect(status(r, "A05:2021").cwes).toContain("CWE-693");
});

it("summary counts every OWASP category exactly once", () => {
  const r = assessSecurityControls([find("SQL injection"), find("SSRF to cloud metadata")]);
  const total = r.summary.gap + r.summary.checked_clear + r.summary.compensated + r.summary.not_assessed;
  expect(total).toBe(OWASP_TOP_10_2021.length);
  expect(r.summary.gap).toBeGreaterThanOrEqual(2); // A03 + A10
});
