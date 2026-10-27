/** @jest-environment node */
/**
 * The fixed-version data is keyed to the bundled KEV snapshot: every CVE a rule
 * names must be a tracked KEV entry (no fixed versions for a flaw CISA does not
 * list as exploited), ids are unique, versions are well formed, and the PHP2Shell
 * data is the operator-confirmed set.
 */
import { FIXED_VERSION_RULES, FIXED_VERSION_CVES } from "../fixed-versions";
import { kevEntry } from "..";

const VERSION = /^\d+(\.\d+){1,3}$/;

describe("fixed-version data", () => {
  it("every CVE is in the bundled KEV snapshot", () => {
    for (const cve of FIXED_VERSION_CVES) expect(kevEntry(cve)).not.toBeNull();
  });

  it("rule ids and plugin slugs are unique", () => {
    const ids = FIXED_VERSION_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const slugs = FIXED_VERSION_RULES.filter((r) => r.slug).map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("every rule has a certain fix to compare against, and plain-language text", () => {
    for (const r of FIXED_VERSION_RULES) {
      if (r.product === "php") {
        expect(r.branches?.length).toBeGreaterThan(0);
        for (const b of r.branches ?? []) {
          expect(b.fixed).toMatch(VERSION);
          expect(b.fixed.startsWith(`${b.line}.`)).toBe(true);
        }
      } else {
        expect(r.slug).toMatch(/^[a-z0-9-]+$/);
        expect(r.fixed).toMatch(VERSION);
      }
      if (r.affectedFrom) expect(r.affectedFrom).toMatch(VERSION);
      expect(r.howToFix).toContain("{fixed}");
      expect(r.plainName.length).toBeGreaterThan(5);
      expect(`${r.plainName} ${r.impact} ${r.howToFix}`).not.toMatch(/—/); // no em dashes in owner copy
    }
  });

  it("PHP2Shell: 8.5.12, 8.4.27, 8.3.36, 8.2.35; older lines unsupported", () => {
    const php = FIXED_VERSION_RULES.find((r) => r.id === "php2shell")!;
    expect(php.cves).toEqual(["CVE-2026-109618", "CVE-2026-109619"]);
    expect(php.branches).toEqual([
      { line: "8.5", fixed: "8.5.12" },
      { line: "8.4", fixed: "8.4.27" },
      { line: "8.3", fixed: "8.3.36" },
      { line: "8.2", fixed: "8.2.35" },
    ]);
    expect(php.unsupportedBelow).toBe("8.2");
  });
});
