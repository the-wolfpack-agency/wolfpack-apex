/**
 * readValidationOutcome maps the factory-validate run's conclusion to a status the
 * gate acts on: pass / fail / pending / not_dispatched.
 */
const mockRuns = jest.fn();
const mockHead = jest.fn();
jest.mock("@/lib/github-client", () => ({ listWorkflowRunsRaw: (...a: unknown[]) => mockRuns(...a), getBranchHead: (...a: unknown[]) => mockHead(...a) }));
const mockCommit = jest.fn();
jest.mock("@/lib/ai-code/file-changes", () => ({ commitFileChanges: (...a: unknown[]) => mockCommit(...a), filesToDiff: () => "diff-body" }));

import { readValidationOutcome, validationBranchName, pushValidationBranch } from "@/lib/ai-code/pre-pr-validation";

const run = (name: string, conclusion: string | null) => ({ id: 1, name, conclusion, runAttempt: 1 });
beforeEach(() => jest.clearAllMocks());

it("not_dispatched when no factory-validate run exists for the sha", async () => {
  mockRuns.mockResolvedValue([run("agenticqa-full-pipeline", "failure")]);
  expect((await readValidationOutcome({} as never, "o/r", "sha")).status).toBe("not_dispatched");
});
it("pending while the validate run is still going", async () => {
  mockRuns.mockResolvedValue([run("factory-validate", null)]);
  expect((await readValidationOutcome({} as never, "o/r", "sha")).status).toBe("pending");
});
it("pass when the validate run succeeded", async () => {
  mockRuns.mockResolvedValue([run("factory-validate", "success")]);
  expect((await readValidationOutcome({} as never, "o/r", "sha")).status).toBe("pass");
});
it("fail (with the failing names) when the validate run failed", async () => {
  mockRuns.mockResolvedValue([run("factory-validate", "failure")]);
  const o = await readValidationOutcome({} as never, "o/r", "sha");
  expect(o.status).toBe("fail");
  expect(o.failing).toContain("factory-validate");
});
it("unknown (never throws) on a read error", async () => {
  mockRuns.mockRejectedValue(new Error("boom"));
  expect((await readValidationOutcome({} as never, "o/r", "sha")).status).toBe("unknown");
});
it("validationBranchName is stable + sanitized", () => {
  expect(validationBranchName("feat/x y", "abcdef1234")).toBe("factory-validate/feat-x-y-abcdef12");
});

describe("pushValidationBranch (idempotent)", () => {
  beforeEach(() => { mockHead.mockReset(); mockCommit.mockReset(); });
  it("pushes the change when the validation branch does not exist", async () => {
    mockHead.mockRejectedValue(new Error("404"));
    const branch = await pushValidationBranch({} as never, "o/r", [{ path: "src/x.ts", content: "x" }], "main", "feat-x");
    expect(branch).toMatch(/^factory-validate\/feat-x-/);
    expect(mockCommit).toHaveBeenCalledWith(expect.objectContaining({ repoFullName: "o/r", branch, base: "main" }));
  });
  it("reuses the branch (no re-push) when it already exists", async () => {
    mockHead.mockResolvedValue("sha");
    await pushValidationBranch({} as never, "o/r", [{ path: "src/x.ts", content: "x" }], "main", "feat-x");
    expect(mockCommit).not.toHaveBeenCalled();
  });
});

