/**
 * Unit tests for generateInsights (generate.ts) - the engine orchestrator.
 *
 * Asserts the read -> correlate -> persist -> learn flow wires through the injected
 * seams: it reads the OPEN corpus across platforms, persists the computed insights,
 * fires platform.cross_scan_insight_generated PER insight plus the typed
 * correlation/regression sub-events, and DEGRADES GRACEFULLY (still returns the
 * computed insights + fires analytics) when persistence throws.
 *
 * All I/O is injected, so no DB / real analytics is touched. The correlate engine
 * itself is REAL (proven separately in correlate.test.ts).
 */

import { generateInsights } from "@/lib/platform-scan/insights/generate";
import type { ScanFindingRow } from "@/lib/platform-scan/store";

function row(partial: Partial<ScanFindingRow> & Pick<ScanFindingRow, "platform" | "route" | "category" | "title">): ScanFindingRow {
  return {
    id: `f_${partial.title}`,
    scanId: "s1",
    severity: "high",
    detail: "",
    evidence: {},
    status: "open",
    createdAt: "2026-06-28T00:00:00.000Z",
    ...partial,
  } as ScanFindingRow;
}

const actor = { id: "admin-1", role: "admin" };
const NOW = Date.parse("2026-06-28T00:00:00.000Z");

describe("generateInsights", () => {
  test("reads the OPEN corpus across platforms (no platform filter)", async () => {
    const listFindings = jest.fn().mockResolvedValue([]);
    const record = jest.fn().mockResolvedValue({ written: 0 });
    const track = jest.fn();
    await generateInsights("ws-1", actor, { listFindings, record, track });
    expect(listFindings).toHaveBeenCalledWith("ws-1", { status: "open", limit: 500 });
  });

  test("correlates, persists, and fires one insight event per insight", async () => {
    // A compound risk on /checkout (security + broken_journey same route).
    const findings = [
      row({ platform: "acme", route: "/checkout", category: "security", title: "Missing CSRF", severity: "high" }),
      row({ platform: "acme", route: "/checkout", category: "broken_journey", title: "Payment 500", severity: "medium" }),
    ];
    const listFindings = jest.fn().mockResolvedValue(findings);
    const record = jest.fn().mockResolvedValue({ written: 99 });
    const track = jest.fn();

    const { insights, persisted } = await generateInsights("ws-1", actor, {
      listFindings,
      record,
      track,
      options: { now: () => NOW },
    });

    // The compound risk was computed + persisted.
    expect(insights.some((i) => i.kind === "compound_risk")).toBe(true);
    expect(record).toHaveBeenCalledWith(insights);
    expect(persisted).toBe(99);

    // One generated event per insight.
    const generated = track.mock.calls.filter((c) => c[0] === "platform.cross_scan_insight_generated");
    expect(generated).toHaveLength(insights.length);
    // The compound risk also fires the correlation sub-event.
    expect(track).toHaveBeenCalledWith(
      "platform.cross_scan_correlation_detected",
      "admin-1",
      "admin",
      expect.objectContaining({ platform: "acme", route: "/checkout" }),
    );
  });

  test("fires the regression sub-event for a reopened resolved finding", async () => {
    const findings = [row({ platform: "acme", route: "/login", category: "security", title: "SQLi", severity: "critical" })];
    const listFindings = jest.fn().mockResolvedValue(findings);
    const record = jest.fn().mockResolvedValue({ written: 1 });
    const track = jest.fn();

    await generateInsights("ws-1", actor, {
      listFindings,
      record,
      track,
      history: {
        resolved: [
          { platform: "acme", route: "/login", category: "security", title: "SQLi", resolvedAt: "2026-06-20T00:00:00.000Z" },
        ],
      },
      options: { now: () => NOW },
    });

    expect(track).toHaveBeenCalledWith(
      "platform.cross_scan_regression_detected",
      "admin-1",
      "admin",
      expect.objectContaining({ platform: "acme", route: "/login" }),
    );
  });

  test("degrades gracefully: persistence throws -> still returns insights + fires analytics", async () => {
    const findings = [
      row({ platform: "acme", route: "/x", category: "security", title: "a", severity: "high" }),
      row({ platform: "acme", route: "/x", category: "performance", title: "b", severity: "low" }),
    ];
    const listFindings = jest.fn().mockResolvedValue(findings);
    const record = jest.fn().mockRejectedValue(new Error("db down"));
    const track = jest.fn();

    const { insights, persisted } = await generateInsights("ws-1", actor, {
      listFindings,
      record,
      track,
      options: { now: () => NOW },
    });

    expect(insights.length).toBeGreaterThan(0);
    expect(persisted).toBe(0); // persistence failed but did not throw
    expect(track).toHaveBeenCalledWith(
      "platform.cross_scan_insight_generated",
      "admin-1",
      "admin",
      expect.any(Object),
    );
  });

  test("degrades gracefully: a listFindings throw yields zero insights, no throw", async () => {
    const listFindings = jest.fn().mockRejectedValue(new Error("read failed"));
    const record = jest.fn().mockResolvedValue({ written: 0 });
    const track = jest.fn();

    const { insights } = await generateInsights("ws-1", actor, { listFindings, record, track });
    expect(insights).toEqual([]);
  });
});
