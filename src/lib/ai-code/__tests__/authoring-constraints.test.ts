/**
 * The authoring-rule catalog is guidance the executor is given, not a second
 * gate. These assert the catalog's integrity and that the brief carries the
 * rules our CI failures taught - each rule pointing at the guardrail that owns
 * enforcement (DRY: this module states, it never re-checks).
 */
import { AUTHORING_RULES, authoringConstraintsBrief } from "../authoring-constraints";

describe("AUTHORING_RULES catalog", () => {
  it("every rule has a unique id, rule text, and an enforcing guardrail", () => {
    const ids = AUTHORING_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(AUTHORING_RULES.every((r) => r.rule.length > 0 && r.enforcedBy.length > 0)).toBe(true);
  });

  it("covers the rules that cost round trips this session", () => {
    const ids = new Set(AUTHORING_RULES.map((r) => r.id));
    for (const id of ["route-auth", "route-audit", "no-user-controlled-guard", "inline-prompt", "e2e-register", "silent-catch", "em-dash"]) {
      expect(ids.has(id)).toBe(true);
    }
  });
});

describe("authoringConstraintsBrief", () => {
  it("renders every rule for the executor prompt", () => {
    const brief = authoringConstraintsBrief();
    expect(brief).toMatch(/Repository rules you must satisfy/);
    // a rule from each mechanism class is present
    expect(brief).toMatch(/requireCapability/);
    expect(brief).toMatch(/recordAudit/);
    expect(brief).toMatch(/fetchWithRefresh/);
    expect(brief).toMatch(/register/i);
    expect(brief.split("\n").length).toBe(AUTHORING_RULES.length + 1); // header + one line per rule
  });
});
