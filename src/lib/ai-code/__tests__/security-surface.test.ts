/** touchesSecuritySurface: the gate/guardrails/auth/CSP/CI escalate; ordinary
 *  code does not. */
import { touchesSecuritySurface } from "../security-surface";

describe("touchesSecuritySurface", () => {
  it("flags changes to the protection surface", () => {
    expect(touchesSecuritySurface(["src/middleware.ts"])).toEqual(["src/middleware.ts"]);
    expect(touchesSecuritySurface(["src/lib/auth/require-capability.ts"])).toHaveLength(1);
    expect(touchesSecuritySurface(["src/lib/ai-code/detect.ts"])).toHaveLength(1);
    expect(touchesSecuritySurface(["src/lib/ogiam/authorize.ts"])).toHaveLength(1);
    expect(touchesSecuritySurface(["src/__tests__/capability-coverage.test.ts"])).toHaveLength(1);
    expect(touchesSecuritySurface(["src/__tests__/no-raw-api-fetch.test.ts"])).toHaveLength(1);
    expect(touchesSecuritySurface([".github/workflows/verify.yml"])).toHaveLength(1);
    expect(touchesSecuritySurface(["scripts/verify.sh"])).toHaveLength(1);
  });
  it("does NOT flag ordinary routes/libs/components", () => {
    expect(touchesSecuritySurface(["src/lib/util/clamp.ts", "src/components/StatusPill.tsx", "src/app/api/ping/route.ts"])).toEqual([]);
  });
  it("returns every matched path when a change spans several controls", () => {
    expect(touchesSecuritySurface(["src/middleware.ts", "src/lib/util/x.ts", "scripts/verify.sh"])).toEqual(["src/middleware.ts", "scripts/verify.sh"]);
  });
});
