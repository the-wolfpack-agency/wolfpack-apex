/**
 * Producer/consumer helpers for the failure memory: map a run's CONFIRMED catches
 * to failure docs (producer), build the author-prompt warning from retrieved
 * failures (consumer). rememberRunFailures is never-throwing over a mocked store.
 */
const mockRemember = jest.fn();
jest.mock("@/lib/ai-code/factory-failure-store", () => ({ rememberFailures: (...a: unknown[]) => mockRemember(...a) }));

import {
  confirmedFailuresFromFindings,
  confirmedFailuresFromInvariant,
  rememberRunFailures,
  buildFailureAvoidanceBlock,
} from "@/lib/ai-code/factory-failure-producer";
import type { ScanFinding } from "@/lib/platform-scan/types";

const finding = (over: Partial<ScanFinding>): ScanFinding => ({
  route: "src/x.ts", severity: "high", category: "security", title: "a problem", detail: "", evidence: {}, ...over,
});

beforeEach(() => jest.clearAllMocks());

describe("confirmedFailuresFromFindings", () => {
  it("keeps only critical/high and maps class/summary/path/severity", () => {
    const docs = confirmedFailuresFromFindings([
      finding({ severity: "critical", title: "secret in a log", route: "src/a.ts", category: "security" }),
      finding({ severity: "low", title: "nit" }),
      finding({ severity: "high", title: "ssrf", route: "src/b.ts" }),
    ]);
    expect(docs).toEqual([
      { findingClass: "security", summary: "secret in a log", path: "src/a.ts", severity: "critical" },
      { findingClass: "security", summary: "ssrf", path: "src/b.ts", severity: "high" },
    ]);
  });
  it("skips a finding with no title/detail", () => {
    expect(confirmedFailuresFromFindings([finding({ title: "", detail: "" })])).toEqual([]);
  });
});

describe("confirmedFailuresFromInvariant", () => {
  it("records a blocking invariant, ignores a non-blocking one", () => {
    expect(confirmedFailuresFromInvariant({ wouldBlock: true, ruleId: "R-DEP-ADDED", reason: "a new dependency was added" }))
      .toEqual([{ findingClass: "R-DEP-ADDED", summary: "a new dependency was added", severity: "high" }]);
    expect(confirmedFailuresFromInvariant({ wouldBlock: false, ruleId: "R", reason: "ok" })).toEqual([]);
  });
});

describe("rememberRunFailures", () => {
  it("writes the combined confirmed catches through the store", async () => {
    mockRemember.mockResolvedValue({ written: 2 });
    const r = await rememberRunFailures({
      workspaceId: "w1", repo: "o/r",
      findings: [finding({ severity: "critical", title: "secret in a log" })],
      invariant: { wouldBlock: true, ruleId: "R-DEP", reason: "dep added" },
    });
    expect(r.written).toBe(2);
    const docs = (mockRemember.mock.calls[0][0] as { docs: unknown[] }).docs;
    expect(docs).toHaveLength(2);
  });
  it("no store call when there is nothing confirmed", async () => {
    const r = await rememberRunFailures({ workspaceId: "w1", repo: "o/r", findings: [finding({ severity: "low", title: "nit" })] });
    expect(r.written).toBe(0);
    expect(mockRemember).not.toHaveBeenCalled();
  });
  it("never throws if the store throws", async () => {
    mockRemember.mockRejectedValue(new Error("db down"));
    await expect(rememberRunFailures({ workspaceId: "w1", repo: "o/r", findings: [finding({ severity: "high", title: "x" })] }))
      .resolves.toEqual({ written: 0 });
  });
});

describe("buildFailureAvoidanceBlock", () => {
  it("is empty on no hits (no noise on a cold memory)", () => {
    expect(buildFailureAvoidanceBlock([])).toBe("");
  });
  it("lists the past failures with class + summary + prior path", () => {
    const block = buildFailureAvoidanceBlock([
      { findingClass: "logged_credential", summary: "secret written to a log", path: "src/x.ts", severity: "critical", score: 0.9 },
    ]);
    expect(block).toMatch(/AVOID PAST FAILURES/);
    expect(block).toMatch(/logged_credential: secret written to a log \(previously in src\/x\.ts\)/);
  });
});
