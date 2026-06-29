/**
 * Validation-coverage taxonomy data integrity.
 *
 * The taxonomy backs the client-facing "What we tested" grid on
 * /admin/platform-scans. These tests guard the two promises that matter for a
 * client surface:
 *   1. It is shaped + complete (every row has all three fields, lean count).
 *   2. It is BRAND-FREE: no tool, vendor, or product names leak into copy a
 *      client reads. We assert against a denylist of known scanner/tool names.
 */

import { TESTING_TAXONOMY, type TestingTaxonomyEntry } from "../testing-taxonomy";

// Names that must NEVER appear in client-facing coverage copy. Mix of the
// detection tools the platform reuses internally + leading scanners it
// benchmarks against. Case-insensitive substring match.
const FORBIDDEN_NAMES = [
  "semgrep",
  "openclaw",
  "zap",
  "owasp zap",
  "burp",
  "nuclei",
  "snyk",
  "nessus",
  "qualys",
  "playwright",
  "axe",
  "lighthouse",
  "trivy",
  "checkov",
  "sonarqube",
  "wapiti",
  "nikto",
  "acunetix",
  "qdrant",
  "neo4j",
  "postgres",
];

describe("testing taxonomy", () => {
  it("is a non-empty, lean (8-12 row) typed array", () => {
    expect(Array.isArray(TESTING_TAXONOMY)).toBe(true);
    expect(TESTING_TAXONOMY.length).toBeGreaterThanOrEqual(8);
    expect(TESTING_TAXONOMY.length).toBeLessThanOrEqual(12);
  });

  it("every row has a non-empty area, testingType, and validates", () => {
    for (const row of TESTING_TAXONOMY) {
      const entry: TestingTaxonomyEntry = row;
      expect(typeof entry.area).toBe("string");
      expect(entry.area.trim().length).toBeGreaterThan(0);
      expect(typeof entry.testingType).toBe("string");
      expect(entry.testingType.trim().length).toBeGreaterThan(0);
      expect(typeof entry.validates).toBe("string");
      expect(entry.validates.trim().length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate areas", () => {
    const areas = TESTING_TAXONOMY.map((r) => r.area.toLowerCase());
    expect(new Set(areas).size).toBe(areas.length);
  });

  it("contains NO tool or brand names anywhere in its copy", () => {
    const haystack = TESTING_TAXONOMY.map(
      (r) => `${r.area} ${r.testingType} ${r.validates}`,
    )
      .join(" ")
      .toLowerCase();
    for (const name of FORBIDDEN_NAMES) {
      expect(haystack).not.toContain(name.toLowerCase());
    }
  });

  it("never uses an em dash (house style)", () => {
    const haystack = TESTING_TAXONOMY.map(
      (r) => `${r.area} ${r.testingType} ${r.validates}`,
    ).join(" ");
    expect(haystack.includes("—")).toBe(false);
  });

  it("covers the real platform-scan modalities (dynamic, static, contract, ux, a11y, security, journey, integrity, benchmark)", () => {
    const types = TESTING_TAXONOMY.map((r) => r.testingType.toLowerCase()).join(" | ");
    const areas = TESTING_TAXONOMY.map((r) => r.area.toLowerCase()).join(" | ");
    const all = `${types} ${areas}`;
    expect(all).toContain("dynamic");
    expect(all).toContain("static");
    expect(all).toContain("contract");
    expect(all).toMatch(/experience|usability/);
    expect(all).toContain("accessibility");
    expect(all).toContain("security");
    expect(all).toContain("journey");
    expect(all).toMatch(/integrity|audit/);
    expect(all).toContain("benchmark");
  });
});
