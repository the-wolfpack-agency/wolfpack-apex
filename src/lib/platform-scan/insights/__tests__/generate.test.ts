/**
 * Unit tests for generateInsights (generate.ts) - the engine orchestrator.
 *
 * Asserts the read -> correlate -> persist -> learn flow wires through the injected
 * seams: it reads the OPEN corpus across platforms, BUILDS regression history from
 * the RESOLVED corpus (FIX 1), persists the computed insights TENANT-SCOPED (FIX 2),
 * fires platform.cross_scan_insight_generated PER insight plus the typed
 * correlation/regression sub-events, and DEGRADES GRACEFULLY - still returning the
 * computed insights AND firing the platform.scan_read_degraded /
 * platform.scan_persist_degraded learning signals (FIX 8) when read/persist fail.
 *
 * All I/O is injected, so no DB / real analytics is touched. The correlate engine
 * itself is REAL (proven separately in correlate.test.ts).
 */

import { generateInsights } from "@/lib/platform-scan/insights/generate";
import type { ScanFindingRow } from "@/lib/platform-scan/store";

function row(
  partial: Partial<ScanFindingRow> & Pick<ScanFindingRow, "platform" | "route" | "category" | "title">,
): ScanFindingRow {
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

/** A listFindings fake that returns `open` rows for the open call and `resolved`
 *  rows for the resolved call, so the open + history reads are both exercised. */
function fakeStore(open: ScanFindingRow[], resolved: ScanFindingRow[] = []) {
  return jest.fn(async (_ws: string, o?: { status?: string }) =>
    o?.status === "resolved" ? resolved : open,
  );
}

describe("generateInsights", () => {
  test("reads the OPEN corpus AND the RESOLVED corpus (FIX 1 - history is built)", async () => {
    const listFindings = fakeStore([], []);
    const record = jest.fn().mockResolvedValue({ written: 0 });
    const track = jest.fn();
    await generateInsights("ws-1", actor, { listFindings, record, track });
    expect(listFindings).toHaveBeenCalledWith("ws-1", { status: "open", limit: 500 });
    expect(listFindings).toHaveBeenCalledWith("ws-1", { status: "resolved", limit: 500 });
  });

  test("correlates, persists TENANT-SCOPED, and fires one insight event per insight", async () => {
    const findings = [
      row({ platform: "acme", route: "/checkout", category: "security", title: "Missing CSRF", severity: "high" }),
      row({ platform: "acme", route: "/checkout", category: "broken_journey", title: "Payment 500", severity: "medium" }),
    ];
    const listFindings = fakeStore(findings);
    const record = jest.fn().mockResolvedValue({ written: 99 });
    const track = jest.fn();

    const { insights, persisted } = await generateInsights("ws-1", actor, {
      listFindings,
      record,
      track,
      options: { now: () => NOW },
    });

    expect(insights.some((i) => i.kind === "compound_risk")).toBe(true);
    // FIX 2: record is called with (insights, workspaceId).
    expect(record).toHaveBeenCalledWith(insights, "ws-1");
    expect(persisted).toBe(99);

    const generated = track.mock.calls.filter((c) => c[0] === "platform.cross_scan_insight_generated");
    expect(generated).toHaveLength(insights.length);
    expect(track).toHaveBeenCalledWith(
      "platform.cross_scan_correlation_detected",
      "admin-1",
      "admin",
      expect.objectContaining({ platform: "acme", route: "/checkout" }),
    );
  });

  test("FIX 1: regression FIRES end-to-end from the RESOLVED corpus (not just injected history)", async () => {
    // Open finding created AFTER the resolved row's timestamp -> a genuine reopen.
    const open = [
      row({
        platform: "acme",
        route: "/login",
        category: "security",
        title: "SQLi",
        severity: "critical",
        createdAt: "2026-06-26T00:00:00.000Z",
      }),
    ];
    const resolved = [
      row({
        platform: "acme",
        route: "/login",
        category: "security",
        title: "SQLi",
        status: "resolved",
        createdAt: "2026-06-20T00:00:00.000Z", // used as resolvedAt proxy
      }),
    ];
    const listFindings = fakeStore(open, resolved);
    const record = jest.fn().mockResolvedValue({ written: 1 });
    const track = jest.fn();

    const { insights } = await generateInsights("ws-1", actor, {
      listFindings,
      record,
      track,
      options: { now: () => NOW },
    });

    expect(insights.some((i) => i.kind === "regression")).toBe(true);
    expect(track).toHaveBeenCalledWith(
      "platform.cross_scan_regression_detected",
      "admin-1",
      "admin",
      expect.objectContaining({ platform: "acme", route: "/login" }),
    );
  });

  test("injected deps.history wins over the resolved-corpus read", async () => {
    const open = [
      row({ platform: "acme", route: "/login", category: "security", title: "SQLi", severity: "critical", createdAt: "2026-06-26T00:00:00.000Z" }),
    ];
    const listFindings = fakeStore(open, /* resolved */ []);
    const record = jest.fn().mockResolvedValue({ written: 1 });
    const track = jest.fn();

    const { insights } = await generateInsights("ws-1", actor, {
      listFindings,
      record,
      track,
      history: {
        resolved: [{ platform: "acme", route: "/login", category: "security", title: "SQLi", resolvedAt: "2026-06-20T00:00:00.000Z" }],
      },
      options: { now: () => NOW },
    });

    expect(insights.some((i) => i.kind === "regression")).toBe(true);
    // The resolved-corpus read is skipped when history is injected.
    expect(listFindings).not.toHaveBeenCalledWith("ws-1", { status: "resolved", limit: 500 });
  });

  test("FIX 8: persistence throw -> still returns insights, fires scan_persist_degraded", async () => {
    const findings = [
      row({ platform: "acme", route: "/x", category: "security", title: "a", severity: "high" }),
      row({ platform: "acme", route: "/x", category: "performance", title: "b", severity: "high" }),
    ];
    const listFindings = fakeStore(findings);
    const record = jest.fn().mockRejectedValue(new Error("db down"));
    const track = jest.fn();

    const { insights, persisted } = await generateInsights("ws-1", actor, {
      listFindings,
      record,
      track,
      options: { now: () => NOW },
    });

    expect(insights.length).toBeGreaterThan(0);
    expect(persisted).toBe(0);
    expect(track).toHaveBeenCalledWith(
      "platform.scan_persist_degraded",
      "admin-1",
      "admin",
      expect.objectContaining({ surface: "cross_scan", detail: "db down" }),
    );
  });

  test("FIX 8: a listFindings(open) throw yields zero insights AND fires scan_read_degraded", async () => {
    const listFindings = jest.fn().mockRejectedValue(new Error("read failed"));
    const record = jest.fn().mockResolvedValue({ written: 0 });
    const track = jest.fn();

    const { insights } = await generateInsights("ws-1", actor, { listFindings, record, track });
    expect(insights).toEqual([]);
    expect(track).toHaveBeenCalledWith(
      "platform.scan_read_degraded",
      "admin-1",
      "admin",
      expect.objectContaining({ surface: "cross_scan", detail: "read failed" }),
    );
  });

  test("FIX 8: a resolved-corpus read throw degrades to no-history + fires scan_read_degraded", async () => {
    // open read succeeds, resolved read throws.
    const listFindings = jest.fn(async (_ws: string, o?: { status?: string }) => {
      if (o?.status === "resolved") throw new Error("resolved read failed");
      return [] as ScanFindingRow[];
    });
    const record = jest.fn().mockResolvedValue({ written: 0 });
    const track = jest.fn();

    const { insights } = await generateInsights("ws-1", actor, { listFindings, record, track });
    expect(insights).toEqual([]); // no findings -> nothing to correlate, but no throw
    expect(track).toHaveBeenCalledWith(
      "platform.scan_read_degraded",
      "admin-1",
      "admin",
      expect.objectContaining({ surface: "cross_scan", detail: "resolved read failed" }),
    );
  });
});
