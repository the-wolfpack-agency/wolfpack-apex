import { computeDrift, MIN_SAMPLES, PAUSE_THRESHOLD } from "@/lib/agents/drift/detect";
import type { BehaviorMetrics } from "@/lib/agents/drift/metrics";

function metrics(over: Partial<BehaviorMetrics>): BehaviorMetrics {
  return { count: 50, blockRate: 0, tierDist: { low: 1 }, outcomeDist: { allow: 1 }, toolDist: { a: 1 }, ...over };
}

describe("computeDrift", () => {
  it("reports insufficient_data when either window is too small", () => {
    const r = computeDrift(metrics({ count: MIN_SAMPLES - 1 }), metrics({}));
    expect(r.verdict).toBe("insufficient_data");
    expect(r.shouldPause).toBe(false);
  });
  it("is stable when behavior matches the baseline", () => {
    const r = computeDrift(metrics({}), metrics({}));
    expect(r.verdict).toBe("stable");
    expect(r.score).toBe(0);
  });
  it("flags critical and pauses when the block rate jumps", () => {
    const r = computeDrift(metrics({ blockRate: 0.05 }), metrics({ blockRate: 0.05 + PAUSE_THRESHOLD + 0.1 }));
    expect(r.verdict).toBe("critical");
    expect(r.shouldPause).toBe(true);
    expect(r.components.blockRateDelta).toBeGreaterThanOrEqual(PAUSE_THRESHOLD);
  });
  it("flags critical when the tool mix diverges entirely", () => {
    const r = computeDrift(metrics({ toolDist: { a: 1 } }), metrics({ toolDist: { z: 1 } }));
    expect(r.components.toolDistance).toBe(1);
    expect(r.verdict).toBe("critical");
  });
  it("flags drifting for a moderate shift below the pause line", () => {
    const r = computeDrift(metrics({ toolDist: { a: 1 } }), metrics({ toolDist: { a: 0.7, b: 0.3 } }));
    expect(r.verdict).toBe("drifting");
    expect(r.shouldPause).toBe(false);
  });
});
