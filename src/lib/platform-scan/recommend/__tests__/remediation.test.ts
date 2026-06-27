/**
 * Remediation plan + openRemediationPR tests. The plan builder is pure (asserted
 * directly); openRemediationPR is exercised with the github-client and the OGIAM
 * authorize boundary mocked, so no network is touched. Covers the monitor-mode
 * happy path (gate records, PR opens) and the enforce-mode block (no writes).
 */
const mockCreateBranch = jest.fn();
const mockPutFile = jest.fn();
const mockOpenPullRequest = jest.fn();
const mockDefaultGithubClient = jest.fn(() => ({ token: "ghp_test", fetch: globalThis.fetch }));
const mockAuthorize = jest.fn();

jest.mock("@/lib/github-client", () => ({
  createBranch: (...a: unknown[]) => mockCreateBranch(...a),
  putFile: (...a: unknown[]) => mockPutFile(...a),
  openPullRequest: (...a: unknown[]) => mockOpenPullRequest(...a),
  defaultGithubClient: () => mockDefaultGithubClient(),
}));
jest.mock("@/lib/ogiam/authorize", () => ({ authorize: (...a: unknown[]) => mockAuthorize(...a) }));

import { buildRemediationPlan, openRemediationPR } from "@/lib/platform-scan/recommend/remediation";
import type { RecommendationRow } from "@/lib/platform-scan/recommend/store";

const REC: RecommendationRow = {
  id: "rec-12345678",
  platform: "wolfpack-auto",
  key: "security_remediation:headers",
  category: "security_remediation",
  priority: "high",
  title: "Add a security-headers middleware",
  rationale: "3 responses missing headers.",
  suggestedAction: "Set the headers in middleware.",
  source: "finding:security",
  evidence: { count: 3 },
  status: "proposed",
  createdAt: "2026-06-27T00:00:00.000Z",
  prUrl: null,
};

const fakeClient = { token: "ghp_test", fetch: globalThis.fetch };

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthorize.mockResolvedValue({
    enforced: false,
    effectiveOutcome: "monitor",
    intendedOutcome: "allow",
    mode: "monitor",
    riskTier: "medium",
    policyVersion: "v1",
    ruleId: "default",
    reason: "monitor",
    wouldBlock: false,
  });
  mockOpenPullRequest.mockResolvedValue({ html_url: "https://github.com/o/r/pull/7", number: 7 });
});

describe("buildRemediationPlan", () => {
  it("derives the branch, doc path, title, and body deterministically from the rec", () => {
    const plan = buildRemediationPlan(REC, "main");

    expect(plan.branch.startsWith("ogiam/remediate-security-remediation-headers-")).toBe(true);
    expect(plan.branch).toContain("rec-1234");
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0].path).toBe("docs/remediation/security-remediation-headers.md");
    expect(plan.title).toBe("OGIAM remediation: Add a security-headers middleware");

    const doc = plan.files[0].content;
    expect(doc).toContain(REC.title);
    expect(doc).toContain(REC.rationale);
    expect(doc).toContain(REC.suggestedAction);
    expect(doc).toContain("count: 3");
    expect(doc).toContain("Acceptance criteria");
  });
});

describe("openRemediationPR", () => {
  const input = {
    rec: REC,
    repoFullName: "o/r",
    baseBranch: "main",
    workspaceId: "ws-1",
    actor: { userId: "admin-1", role: "admin" },
  };

  it("monitor mode: gates, branches, commits each file on the branch, opens the PR, returns the result", async () => {
    const plan = buildRemediationPlan(REC, "main");
    const result = await openRemediationPR(input, fakeClient);

    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "remediation.open_pr", isMutation: true, mode: "monitor" }),
    );

    expect(mockCreateBranch).toHaveBeenCalledWith(fakeClient, "o/r", plan.branch, "main");

    expect(mockPutFile).toHaveBeenCalledTimes(plan.files.length);
    expect(mockPutFile).toHaveBeenCalledWith(
      fakeClient,
      "o/r",
      plan.files[0].path,
      plan.files[0].content,
      expect.any(String),
      plan.branch,
    );

    expect(result).toEqual({
      prUrl: "https://github.com/o/r/pull/7",
      prNumber: 7,
      branch: plan.branch,
      decision: expect.objectContaining({ effectiveOutcome: "monitor" }),
    });
  });

  it("enforce-block: a denying gate throws gate_blocked and writes NOTHING", async () => {
    mockAuthorize.mockResolvedValue({
      enforced: true,
      effectiveOutcome: "deny",
      intendedOutcome: "deny",
      mode: "enforce",
      riskTier: "high",
      policyVersion: "v1",
      ruleId: "r",
      reason: "x",
      wouldBlock: true,
    });

    await expect(openRemediationPR(input, fakeClient)).rejects.toThrow(/gate_blocked/);
    expect(mockCreateBranch).not.toHaveBeenCalled();
    expect(mockPutFile).not.toHaveBeenCalled();
    expect(mockOpenPullRequest).not.toHaveBeenCalled();
  });
});
