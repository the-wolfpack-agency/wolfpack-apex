/** Policy-as-code: additive org rules (deny patterns + protected paths); the
 *  default is a no-op (zero regression); malformed client regex is skipped. */
import { applyDenyRules, touchesPolicyProtectedPaths, DEFAULT_CODE_GATE_POLICY, type CodeGatePolicy } from "../policy";

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
