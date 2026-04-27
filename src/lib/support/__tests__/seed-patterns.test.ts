/**
 * seed-patterns — pure data tests.
 *
 * Asserts the 5 seed entries:
 *   - parse cleanly (already imported as TS objects, but we still
 *     re-test shape so a future operator edit can't drop a field)
 *   - have at least one valid match signature
 *   - have a non-empty draft template
 *   - have a unique slug
 */

import { SEED_PATTERNS } from "@/lib/support/seed-patterns";
import { isMatchSignature } from "@/lib/support/types";

describe("SEED_PATTERNS", () => {
  it("ships exactly 5 starter patterns", () => {
    expect(SEED_PATTERNS).toHaveLength(5);
  });

  it("every pattern has a unique non-empty slug", () => {
    const slugs = SEED_PATTERNS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) {
      expect(s).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("every pattern has a name + category", () => {
    for (const p of SEED_PATTERNS) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.category.length).toBeGreaterThan(0);
    }
  });

  it("every pattern has at least one valid match signature", () => {
    for (const p of SEED_PATTERNS) {
      expect(p.match_signatures.length).toBeGreaterThan(0);
      for (const sig of p.match_signatures) {
        expect(isMatchSignature(sig)).toBe(true);
      }
    }
  });

  it("every regex signature compiles", () => {
    for (const p of SEED_PATTERNS) {
      for (const sig of p.match_signatures) {
        if (sig.type === "regex") {
          expect(() => new RegExp(sig.pattern, sig.flags)).not.toThrow();
        }
      }
    }
  });

  it("every pattern has a non-empty draft template signed by The Wolfpack Team", () => {
    for (const p of SEED_PATTERNS) {
      expect(p.draft_template.length).toBeGreaterThan(40);
      expect(p.draft_template).toContain("The Wolfpack Team");
    }
  });

  it("no draft template contains an em dash", () => {
    for (const p of SEED_PATTERNS) {
      expect(p.draft_template).not.toContain("—");
    }
  });

  it("includes the 5 expected starter slugs", () => {
    const slugs = SEED_PATTERNS.map((p) => p.slug).sort();
    expect(slugs).toEqual(
      [
        "aadsts20012-ws-fed",
        "aadsts50034-account-not-found",
        "aadsts50126-bad-credentials",
        "mfa-locked-out",
        "outlook-license-missing",
      ].sort(),
    );
  });
});
