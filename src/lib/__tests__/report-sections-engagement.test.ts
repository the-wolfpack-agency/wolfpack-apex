/**
 * The Security Engagement report sections are the client deliverable, so each is
 * asserted to (a) render real store data into Markdown, (b) degrade to an
 * explicit empty-state (never throw / never blank), and (c) compute the posture
 * grade correctly. Stores are mocked so the sections are tested in isolation.
 */
const mockSummarize = jest.fn();
const mockListFindings = jest.fn();
const mockListScans = jest.fn();
const mockQueryAuditLog = jest.fn();

jest.mock("@/lib/platform-scan/store", () => ({
  summarizeFindings: (...a: unknown[]) => mockSummarize(...a),
  listFindings: (...a: unknown[]) => mockListFindings(...a),
  listScans: (...a: unknown[]) => mockListScans(...a),
}));
jest.mock("@/lib/audit-log", () => ({
  queryAuditLog: (...a: unknown[]) => mockQueryAuditLog(...a),
}));

import {
  postureGrade,
  genEngagementSummary,
  genSecurityFindings,
  genDiagnosedIssues,
  genWorkPerformed,
  genScanCoverage,
  genRecommendations,
} from "@/lib/report-sections-engagement";

const ctx = { clientName: "Acme", workspaceId: "ws-1" };
const sev = (o: Partial<Record<"critical" | "high" | "medium" | "low", number>>) => ({
  critical: 0, high: 0, medium: 0, low: 0, ...o,
});
const summary = (o: Parameters<typeof sev>[0], byCategory: Record<string, number> = {}) => ({
  total: Object.values(sev(o)).reduce((a, b) => a + b, 0),
  bySeverity: sev(o),
  byCategory,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockSummarize.mockResolvedValue(summary({}));
  mockListFindings.mockResolvedValue([]);
  mockListScans.mockResolvedValue([]);
  mockQueryAuditLog.mockResolvedValue({ entries: [] });
});

describe("postureGrade", () => {
  it("fails (F) on any critical, grades down by high, A when clean", () => {
    expect(postureGrade(summary({ critical: 1 })).grade).toBe("F");
    expect(postureGrade(summary({ high: 5 })).grade).toBe("D");
    expect(postureGrade(summary({ high: 1 })).grade).toBe("C");
    expect(postureGrade(summary({ medium: 2 })).grade).toBe("B");
    expect(postureGrade(summary({ low: 3 })).grade).toBe("A-");
    expect(postureGrade(summary({})).grade).toBe("A");
  });
});

describe("genEngagementSummary", () => {
  it("renders the grade, counts, and scoped workspace", async () => {
    mockSummarize.mockResolvedValue(summary({ critical: 2, high: 1 }));
    mockListScans.mockResolvedValue([{ platform: "wolfpack-auto", routeCount: 13, findingCount: 4, criticalCount: 2, createdAt: "2026-06-27T08:00:00.000Z" }]);
    const md = await genEngagementSummary(ctx);
    expect(mockSummarize).toHaveBeenCalledWith("ws-1");
    expect(md).toContain("## Executive Summary");
    expect(md).toContain("posture grade: F");
    expect(md).toContain("| Critical | 2 |");
    expect(md).toContain("wolfpack-auto");
  });
  it("defaults workspace to 'default' when unset", async () => {
    await genEngagementSummary({ clientName: "X" });
    expect(mockSummarize).toHaveBeenCalledWith("default");
  });
});

describe("genSecurityFindings", () => {
  it("tables critical/high security findings with remediation", async () => {
    mockListFindings.mockResolvedValue([
      { platform: "p", route: "/admin/leads", severity: "critical", category: "security", title: "Served without auth" },
      { platform: "p", route: "/x", severity: "high", category: "bug", title: "not security" },
    ]);
    const md = await genSecurityFindings(ctx);
    expect(md).toContain("Served without auth");
    expect(md).not.toContain("not security"); // bug filtered out of the security section
    expect(md).toContain("Remediation guidance");
  });
  it("shows an explicit empty state when none", async () => {
    const md = await genSecurityFindings(ctx);
    expect(md).toContain("No open critical or high security findings");
  });
});

describe("genDiagnosedIssues", () => {
  it("includes functional/UX issues and excludes security", async () => {
    mockListFindings.mockResolvedValue([
      { platform: "p", route: "/a", severity: "high", category: "bug", title: "500 error" },
      { platform: "p", route: "/b", severity: "medium", category: "security", title: "header" },
    ]);
    const md = await genDiagnosedIssues(ctx);
    expect(md).toContain("500 error");
    expect(md).not.toContain("header");
  });
});

describe("genWorkPerformed", () => {
  it("aggregates audited actions by count and never throws on audit failure", async () => {
    mockQueryAuditLog.mockResolvedValue({ entries: [
      { action: "platform.scan_run", ts: "t" },
      { action: "platform.scan_run", ts: "t" },
      { action: "agent.task_completed", ts: "t" },
    ] });
    const md = await genWorkPerformed(ctx);
    expect(md).toContain("platform.scan_run");
    expect(md).toContain("| `platform.scan_run` | 2 |");
    expect(md).toContain("Total audited actions: 3");

    mockQueryAuditLog.mockRejectedValue(new Error("audit down"));
    const md2 = await genWorkPerformed(ctx);
    expect(md2).toContain("No audited actions recorded");
  });
});

describe("genScanCoverage", () => {
  it("tables scan runs", async () => {
    mockListScans.mockResolvedValue([{ platform: "beyond", routeCount: 9, findingCount: 1, criticalCount: 0, createdAt: "2026-06-27T08:00:00.000Z" }]);
    const md = await genScanCoverage(ctx);
    expect(md).toContain("| beyond | 9 | 1 | 0 |");
  });
});

describe("genRecommendations", () => {
  it("prioritizes criticals and always recommends SAST + cadence", async () => {
    mockSummarize.mockResolvedValue(summary({ critical: 3 }, { security: 2 }));
    const md = await genRecommendations(ctx);
    expect(md).toContain("3 critical");
    expect(md).toContain("Semgrep");
    expect(md).toMatch(/cadence/i);
  });
});
