/** Policy-as-code: additive org rules (deny patterns + protected paths); the
 *  default is a no-op (zero regression); malformed client regex is skipped. */
import { applyDenyRules, touchesPolicyProtectedPaths, DEFAULT_CODE_GATE_POLICY, sanitizePolicyInput, looksCatastrophic, MAX_PROTECTED_PATHS, MAX_DENY_RULES, MAX_PATTERN_LENGTH, type CodeGatePolicy } from "../policy";

describe("policy-as-code (additive-only)", () => {
  it("DEFAULT policy is a no-op (zero regression)", () => {
    expect(applyDenyRules({ "a.ts": "import _ from 'lodash';" }, DEFAULT_CODE_GATE_POLICY)).toEqual([]);
    expect(touchesPolicyProtectedPaths(["src/x.ts"], DEFAULT_CODE_GATE_POLICY)).toEqual([]);
  });

  it("flags a client deny rule (e.g. 'no lodash') with the org severity", () => {
    const policy: CodeGatePolicy = { protectedPaths: [], denyRules: [{ pattern: "from ['\"]lodash['\"]", severity: "high", title: "No lodash (bundle policy)" }] };
    const f = applyDenyRules({ "a.ts": "import x from 'lodash';\nconst y = 1;" }, policy);
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("high");
    expect(f[0].title).toMatch(/Org policy: No lodash/);
  });

  it("escalates a change touching a client PROTECTED path", () => {
    const policy: CodeGatePolicy = { protectedPaths: ["^src/payments/"], denyRules: [] };
    expect(touchesPolicyProtectedPaths(["src/payments/charge.ts", "src/util/x.ts"], policy)).toEqual(["src/payments/charge.ts"]);
  });

  it("skips a malformed client regex instead of throwing", () => {
    const bad: CodeGatePolicy = { protectedPaths: ["([unclosed"], denyRules: [{ pattern: "([bad", severity: "high", title: "bad" }] };
    expect(() => applyDenyRules({ "a.ts": "x" }, bad)).not.toThrow();
    expect(applyDenyRules({ "a.ts": "x" }, bad)).toEqual([]);
    expect(touchesPolicyProtectedPaths(["src/a.ts"], bad)).toEqual([]);
  });
});

describe("sanitizePolicyInput (untrusted edit -> safe, additive policy)", () => {
  it("accepts a well-formed policy unchanged", () => {
    const { policy, warnings } = sanitizePolicyInput({
      protectedPaths: ["src/lib/crypto/"],
      denyRules: [{ title: "no moment", pattern: "require\\(['\"]moment", severity: "high", detail: "use date-fns" }],
    });
    expect(policy.protectedPaths).toEqual(["src/lib/crypto/"]);
    expect(policy.denyRules[0]).toMatchObject({ title: "no moment", severity: "high", detail: "use date-fns" });
    expect(warnings).toEqual([]);
  });

  it("drops an invalid protected-path regex with a warning", () => {
    const { policy, warnings } = sanitizePolicyInput({ protectedPaths: ["([", "src/ok/"] });
    expect(policy.protectedPaths).toEqual(["src/ok/"]);
    expect(warnings.join(" ")).toMatch(/invalid protected-path/i);
  });

  it("drops a deny rule missing title or pattern, and one with a bad regex", () => {
    const { policy } = sanitizePolicyInput({ denyRules: [
      { title: "", pattern: "x" },
      { title: "y", pattern: "" },
      { title: "bad", pattern: "([" },
      { title: "ok", pattern: "foo" },
    ] });
    expect(policy.denyRules.map((r) => r.title)).toEqual(["ok"]);
  });

  it("defaults an unknown severity to high (with a warning), keeps valid ones", () => {
    const { policy, warnings } = sanitizePolicyInput({ denyRules: [
      { title: "a", pattern: "a", severity: "nonsense" },
      { title: "b", pattern: "b", severity: "critical" },
    ] });
    expect(policy.denyRules[0].severity).toBe("high");
    expect(policy.denyRules[1].severity).toBe("critical");
    expect(warnings.join(" ")).toMatch(/defaulted to high/i);
  });

  it("de-duplicates and caps to the max counts", () => {
    const paths = Array.from({ length: MAX_PROTECTED_PATHS + 10 }, (_, i) => `p${i}/`);
    const rules = Array.from({ length: MAX_DENY_RULES + 10 }, (_, i) => ({ title: `t${i}`, pattern: `r${i}` }));
    const { policy, warnings } = sanitizePolicyInput({ protectedPaths: [...paths, paths[0]], denyRules: rules });
    expect(policy.protectedPaths.length).toBe(MAX_PROTECTED_PATHS);
    expect(policy.denyRules.length).toBe(MAX_DENY_RULES);
    expect(warnings.join(" ")).toMatch(/first 100/);
  });

  it("garbage input -> empty policy, never throws", () => {
    expect(sanitizePolicyInput(null).policy).toEqual(DEFAULT_CODE_GATE_POLICY);
    expect(sanitizePolicyInput("nope").policy).toEqual(DEFAULT_CODE_GATE_POLICY);
    expect(sanitizePolicyInput({ protectedPaths: "x", denyRules: 5 }).policy).toEqual(DEFAULT_CODE_GATE_POLICY);
  });

  it("the sanitized result is round-trip safe for the gate (applyDenyRules runs on it)", () => {
    const { policy } = sanitizePolicyInput({ denyRules: [{ title: "no fetch", pattern: "\\bfetch\\(", severity: "high" }] });
    const findings = applyDenyRules({ "a.ts": "await fetch('/x');" }, policy);
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toMatch(/no fetch/);
  });
});

describe("ReDoS / length guard on client patterns (safeRegex chokepoint)", () => {
  it("flags nested-quantifier shapes as catastrophic", () => {
    for (const bad of ["(a+)+", "(a*)*", "(.*)*", "(x|y+)*", "(\\d+){10,}+"]) {
      expect(looksCatastrophic(bad)).toBe(true);
    }
  });
  it("passes ordinary deny-rule patterns", () => {
    for (const ok of ["require\\(['\"]moment", "\\bfetch\\(", "console\\.debug", "AKIA[0-9A-Z]{16}"]) {
      expect(looksCatastrophic(ok)).toBe(false);
    }
  });
  it("sanitizePolicyInput drops a catastrophic deny-rule pattern", () => {
    const { policy, warnings } = sanitizePolicyInput({ denyRules: [
      { title: "evil", pattern: "(a+)+$", severity: "high" },
      { title: "fine", pattern: "\\bfetch\\(", severity: "high" },
    ] });
    expect(policy.denyRules.map((r) => r.title)).toEqual(["fine"]);
    expect(warnings.join(" ")).toMatch(/invalid regex/i);
  });
  it("drops an over-length pattern", () => {
    const huge = "a".repeat(MAX_PATTERN_LENGTH + 1);
    const { policy } = sanitizePolicyInput({ protectedPaths: [huge, "src/ok/"] });
    expect(policy.protectedPaths).toEqual(["src/ok/"]);
  });
  it("applyDenyRules never compiles a catastrophic rule (it is skipped, no hang)", () => {
    const findings = applyDenyRules({ "a.ts": "aaaaaaaaaaaaaaaaaaaaX" }, { protectedPaths: [], denyRules: [
      { title: "redos", pattern: "(a+)+$", severity: "critical" },
    ] });
    expect(findings).toEqual([]); // skipped, not run
  });
});
