/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));

const mockFetch = jest.fn();
let user: unknown = { role: "cto" };
jest.mock("@/lib/client-auth", () => ({
  getInstinctUser: () => user,
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "content-type": "application/json" }),
}));

import CodeFactoryPage from "../page";

function resp(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

// The page fetches run history on mount; route assertions by URL, not call index.
const HISTORY_EMPTY = () => resp(200, { runs: [], grade: { total: 0, readyRate: 0, firstPassRate: 0, blockRate: 0, escalationRate: 0, byModel: [] }, drift: [] });
const pipelineCall = () => mockFetch.mock.calls.find((c) => c[0] === "/api/admin/ai-code/pipeline")!;
const approvalCall = () => mockFetch.mock.calls.find((c) => String(c[0]).includes("/approvals/"))!;

const FINDING = {
  file: "lib/x.ts", line: 2, klass: "logged_credential", severity: "critical", cwe: "CWE-532",
  title: "Possible credential written to a log (resetUrl)", detail: "A reset link reached a log.",
};
const EXECUTOR = { diff: "diff --git a/lib/x.ts b/lib/x.ts", author: "gpt-4o-mini", provider: "azure-openai", costUsd: 0.0003, latencyMs: 800, error: null };

function runResp(over: Partial<{ outcome: string; status: string; findings: unknown[]; judgments?: unknown[]; invariants: unknown; deepScan: unknown; approvalId: string | null; openQuestions: unknown[] }> = {}) {
  const outcome = over.outcome ?? "allow";
  return {
    run: {
      ref: "factory",
      status: over.status ?? (outcome === "allow" ? "ready_for_pr" : "needs_human"),
      diff: "diff --git a/lib/x.ts b/lib/x.ts\n+const k = 1;",
      review: {
        ref: "factory", author: "gpt-4o-mini", findings: over.findings ?? [],
        verdict: { outcome, highestSeverity: "none", reason: "clean", ruleId: "C-CLEAN-ALLOW" },
        bySeverity: {}, judgments: over.judgments,
      },
      remediation: { status: "clean", attempts: [], repairerLineage: null, reason: "ok" },
      conformance: { conforms: true, findings: [] },
      openQuestions: over.openQuestions ?? [],
    },
    approvalId: over.approvalId !== undefined ? over.approvalId : outcome === "allow" ? "appr-1" : null,
    executor: EXECUTOR,
    invariants: over.invariants ?? { ruleId: "R-MUTATION-ALLOW", intendedOutcome: "allow", wouldBlock: false, reason: "ok" },
    deepScan: over.deepScan ?? { scanned: 1, critical: 0, high: 0, blocking: false },
    cost: { actualUsd: 0.0003, inputTokens: 500, outputTokens: 800, attempts: 1, comparison: [{ model: "gpt-4o-mini", provider: "openai", tier: "small", costUsd: 0.000555 }, { model: "gpt-4o", provider: "openai", tier: "large", costUsd: 0.00925 }] },
  };
}

async function submitPrompt(text = "add isPalindrome with tests") {
  fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: text } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /generate & gate/i })); });
}

let pipelineResp: Response;
let approveResp: Response;
let historyResp: Response;
let ciResp: Response;
beforeEach(() => {
  jest.clearAllMocks();
  user = { role: "cto" };
  pipelineResp = resp(200, runResp({ outcome: "allow" }));
  approveResp = resp(200, { ok: true, status: "executed", outcome: { ok: true, url: "https://github.com/o/r/pull/42", number: 42 } });
  historyResp = HISTORY_EMPTY();
  ciResp = resp(200, { dashboard: { categories: [{ key: "unit", label: "Unit tests", status: "pass", passed: 3, failed: 0, pending: 0, checks: ["unit"] }, { key: "security", label: "Security", status: "fail", passed: 0, failed: 1, pending: 0, checks: ["scan"] }], overall: "fail", summary: { total: 4, passed: 3, failed: 1, pending: 0 } } });
  // URL-aware: the page fetches run history on mount and after each run; route it
  // to an empty history so it never consumes a per-test response. Everything else
  // is the pipeline unless it targets the approvals endpoint.
  mockFetch.mockImplementation((url: string) => {
    const u = String(url);
    if (u.includes("/ai-code/history")) return Promise.resolve(historyResp);
    if (u.includes("/ai-code/ci")) return Promise.resolve(ciResp);
    if (u.includes("/approvals/")) return Promise.resolve(approveResp);
    return Promise.resolve(pipelineResp);
  });
});

test("redirects an unauthenticated user to login, never a blank page", () => {
  user = null;
  render(<CodeFactoryPage />);
  expect(mockPush).toHaveBeenCalledWith("/login?next=/admin/ai-code");
});

test("sends the chosen target repo in the pipeline request", async () => {
  pipelineResp = resp(200, runResp({ outcome: "allow" }));
  render(<CodeFactoryPage />);
  fireEvent.change(screen.getByLabelText("Target repo"), { target: { value: "acme/app" } });
  await submitPrompt();
  const body = JSON.parse((pipelineCall()[1] as { body: string }).body);
  expect(body.repo).toBe("acme/app");
});

test("submits a PROMPT (no diff) to the pipeline and shows the executor + allow verdict", async () => {
  pipelineResp = resp(200, runResp({ outcome: "allow" }));
  render(<CodeFactoryPage />);
  await submitPrompt();
  // it posted a prompt, not a diff
  const body = JSON.parse((pipelineCall()[1] as { body: string }).body);
  expect(body.prompt).toContain("isPalindrome");
  expect(body).not.toHaveProperty("diff");
  expect(pipelineCall()[0]).toBe("/api/admin/ai-code/pipeline");
  // no repo entered -> the field is omitted (executor defaults to apex)
  expect(body.repo).toBeUndefined();
  // executor + verdict render
  await waitFor(() => expect(screen.getAllByText("gpt-4o-mini").length).toBeGreaterThan(0)); // executor + cost table
  expect(screen.getByText(/Allowed/)).toBeInTheDocument();
  expect(screen.getAllByText(/Ready for PR/).length).toBeGreaterThan(0); // verdict pill + handoff status
});

test("shows a block verdict with the finding, and needs-human status", async () => {
  pipelineResp = resp(200, runResp({ outcome: "block", findings: [FINDING] }));
  render(<CodeFactoryPage />);
  await submitPrompt();
  await waitFor(() => expect(screen.getByText(/Blocked - do not merge/)).toBeInTheDocument());
  expect(screen.getByText(/credential written to a log/i)).toBeInTheDocument();
  expect(screen.getAllByText(/Needs human/).length).toBeGreaterThan(0); // verdict pill + handoff status
});

test("shows the independent judge only when judgments are present", async () => {
  pipelineResp = resp(200, runResp({
      outcome: "escalate",
      findings: [FINDING],
      judgments: [{ finding: FINDING, verdict: "confirmed", authorLineage: "openai", judgeLineage: "anthropic", reason: "real issue" }],
    }));
  render(<CodeFactoryPage />);
  await submitPrompt();
  await waitFor(() => expect(screen.getByText(/Independent judge/)).toBeInTheDocument());
  expect(screen.getByText(/judged by anthropic/)).toBeInTheDocument();
});

test("surfaces a 422 (executor produced no diff) honestly, without a run", async () => {
  pipelineResp = resp(422, { error: "executor produced no diff", executor: { ...EXECUTOR, diff: "", error: null } });
  render(<CodeFactoryPage />);
  await submitPrompt();
  await waitFor(() => expect(screen.getByText(/did not produce a usable change/i)).toBeInTheDocument());
  // executor evidence still shown; no verdict panel
  expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument();
  expect(screen.queryByText(/Allowed|Blocked/)).not.toBeInTheDocument();
});

test("validates an empty prompt before calling the API", async () => {
  render(<CodeFactoryPage />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /generate & gate/i })); });
  expect(screen.getByRole("alert")).toHaveTextContent(/describe the change/i);
  expect(pipelineCall()).toBeUndefined();
});

test("governance panel: clean invariants + deep scan, handoff captured", async () => {
  pipelineResp = resp(200, runResp({ outcome: "allow" }));
  render(<CodeFactoryPage />);
  await submitPrompt();
  await waitFor(() => expect(screen.getByTestId("governance-panel")).toBeInTheDocument());
  expect(screen.getByText(/Invariants: clear/)).toBeInTheDocument();
  expect(screen.getByText(/Deep scan: clean/)).toBeInTheDocument();
  expect(screen.getByTestId("handoff-status")).toHaveTextContent(/handoff captured/i);
});

test("governance panel: an invariant blocks -> withheld from handoff", async () => {
  pipelineResp = resp(200, runResp({
      outcome: "allow",
      approvalId: null, // withheld
      invariants: { ruleId: "R-DEPENDENCY-ADDED-ESCALATE", intendedOutcome: "escalate", wouldBlock: true, reason: "adds a runtime dependency" },
    }));
  render(<CodeFactoryPage />);
  await submitPrompt();
  await waitFor(() => expect(screen.getByTestId("handoff-status")).toHaveTextContent(/Withheld from PR handoff: R-DEPENDENCY-ADDED-ESCALATE/));
  expect(screen.getByText(/Invariant: R-DEPENDENCY-ADDED-ESCALATE/)).toBeInTheDocument();
});

test("governance panel: a critical deep-scan finding -> withheld from handoff", async () => {
  pipelineResp = resp(200, runResp({
      outcome: "allow",
      approvalId: null,
      deepScan: { scanned: 1, critical: 1, high: 0, blocking: true },
    }));
  render(<CodeFactoryPage />);
  await submitPrompt();
  await waitFor(() => expect(screen.getByText(/Deep scan: 1 critical/)).toBeInTheDocument());
  expect(screen.getByTestId("handoff-status")).toHaveTextContent(/critical security finding/);
});

test("approve & open PR: clicking approve opens the real PR and shows the link", async () => {
  approveResp = resp(200, { ok: true, status: "executed", outcome: { ok: true, url: "https://github.com/o/r/pull/42", number: 42 } });
  render(<CodeFactoryPage />);
  await submitPrompt();
  await waitFor(() => expect(screen.getByTestId("approve-open-pr")).toBeInTheDocument());
  await act(async () => { fireEvent.click(screen.getByTestId("approve-open-pr")); });
  await waitFor(() => expect(screen.getByTestId("pr-link")).toHaveAttribute("href", "https://github.com/o/r/pull/42"));
  // it approved the captured approval id
  expect(approvalCall()[0]).toBe("/api/admin/agents/approvals/appr-1");
});

test("approve failure surfaces the reason, no PR link", async () => {
  approveResp = resp(200, { ok: false, status: "executed", outcome: { ok: false, reason: "no GitHub token configured" } });
  render(<CodeFactoryPage />);
  await submitPrompt();
  await waitFor(() => expect(screen.getByTestId("approve-open-pr")).toBeInTheDocument());
  await act(async () => { fireEvent.click(screen.getByTestId("approve-open-pr")); });
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/no GitHub token/));
  expect(screen.queryByTestId("pr-link")).not.toBeInTheDocument();
});

test("example chips populate the prompt (showing what the factory can do)", async () => {
  render(<CodeFactoryPage />);
  const chips = screen.getByTestId("prompt-chips");
  expect(chips).toBeInTheDocument();
  // clicking a chip fills the prompt textarea
  fireEvent.click(screen.getByRole("button", { name: /slugify\(\) \+ tests/i }));
  expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toMatch(/slugify/i);
  // the negative-demo chip is present, framed as showing the gate block
  expect(screen.getByRole("button", { name: /watch the gate block it/i })).toBeInTheDocument();
});

const OPEN_Q = [
  { id: "tests", prompt: "Testing depth?", options: [{ id: "unit", label: "Unit only" }, { id: "all", label: "Unit, contract and e2e" }], default: "unit" },
];

test("clarifier: open questions render as multiple-choice with the assumed default preselected", async () => {
  pipelineResp = resp(200, runResp({ outcome: "allow", openQuestions: OPEN_Q }));
  render(<CodeFactoryPage />);
  await submitPrompt();
  await waitFor(() => expect(screen.getByTestId("clarifier")).toBeInTheDocument());
  const sel = screen.getByTestId("clarifier-tests") as HTMLSelectElement;
  expect(sel.value).toBe("unit"); // the assumed default
  expect(screen.getByText(/Assumed: Unit only/)).toBeInTheDocument();
});

test("clarifier: changing an answer and re-running sends the confirmed answers", async () => {
  pipelineResp = resp(200, runResp({ outcome: "allow", openQuestions: OPEN_Q }));
  render(<CodeFactoryPage />);
  await submitPrompt();
  await waitFor(() => expect(screen.getByTestId("clarifier-tests")).toBeInTheDocument());
  fireEvent.change(screen.getByTestId("clarifier-tests"), { target: { value: "all" } });
  await act(async () => { fireEvent.click(screen.getByTestId("clarifier-rerun")); });
  const pipelineCalls = mockFetch.mock.calls.filter((c) => c[0] === "/api/admin/ai-code/pipeline");
  const body = JSON.parse((pipelineCalls[pipelineCalls.length - 1][1] as { body: string }).body);
  expect(body.answers).toEqual({ tests: "all" });
});

test("run history panel shows grade, drift, and recent runs when history has data", async () => {
  historyResp = resp(200, {
    runs: [
      { ref: "pr-9", model: "gpt-4o-mini", status: "ready_for_pr", attempts: 0, finalOutcome: "allow", deepScanCritical: 0, conforms: true, createdAt: "2026-09-27T10:00:00Z" },
      { ref: "pr-8", model: "claude", status: "needs_human", attempts: 2, finalOutcome: "block", deepScanCritical: 1, conforms: false, createdAt: "2026-09-27T09:00:00Z" },
    ],
    grade: { total: 2, readyRate: 0.5, firstPassRate: 0.5, blockRate: 0.5, escalationRate: 0.5, byModel: [] },
    drift: [{ model: "claude", priorReadyRate: 0.9, recentReadyRate: 0.4, drop: 0.5, priorN: 6, recentN: 6 }],
  });
  render(<CodeFactoryPage />);
  await waitFor(() => expect(screen.getByTestId("history-grade")).toBeInTheDocument());
  expect(screen.getByText("Run history & quality")).toBeInTheDocument();
  expect(screen.getByTestId("history-drift")).toHaveTextContent(/claude/i);
  expect(screen.getByTestId("history-runs")).toHaveTextContent("pr-9");
});

test("run history panel is hidden when there are no runs", async () => {
  render(<CodeFactoryPage />);
  await waitFor(() => expect(screen.getByTestId("ai-code-page")).toBeInTheDocument());
  expect(screen.queryByTestId("history-grade")).not.toBeInTheDocument();
});

test("pipeline is tied to the opened PR: build & deploy checkpoints appear automatically, no manual ref", async () => {
  pipelineResp = resp(200, runResp({ outcome: "allow" }));
  approveResp = resp(200, { ok: true, status: "executed", outcome: { ok: true, url: "https://github.com/o/r/pull/42", number: 42, branch: "factory/x-abc" } });
  render(<CodeFactoryPage />);
  await submitPrompt();
  await waitFor(() => expect(screen.getByTestId("approve-open-pr")).toBeInTheDocument());
  await act(async () => { fireEvent.click(screen.getByTestId("approve-open-pr")); });
  await waitFor(() => expect(screen.getByTestId("pr-link")).toBeInTheDocument());
  // the pipeline auto-loads for the PR branch - no manual ref input at all
  await waitFor(() => expect(screen.getByTestId("pipeline-dashboard")).toBeInTheDocument());
  expect(screen.getByTestId("pipeline-overall")).toHaveTextContent(/attention needed/i);
  expect(screen.getByTestId("pipeline-cat-unit")).toHaveTextContent(/Unit tests/);
  expect(screen.getByTestId("pipeline-cat-security")).toHaveTextContent(/Failed/);
  expect(screen.getByTestId("pipeline-dashboard")).not.toHaveTextContent(/vercel|codeql|jest|postgres/i);
  expect(screen.queryByTestId("pipeline-ref")).not.toBeInTheDocument(); // no copy-paste chore
});

test("cost meter shows this run's cost and a cross-model comparison", async () => {
  pipelineResp = resp(200, runResp({ outcome: "allow" }));
  render(<CodeFactoryPage />);
  await submitPrompt();
  await waitFor(() => expect(screen.getByTestId("cost-actual")).toBeInTheDocument());
  expect(screen.getByTestId("cost-actual")).toHaveTextContent("$0.0003");
  const table = screen.getByTestId("cost-comparison");
  expect(table).toHaveTextContent("gpt-4o-mini");
  expect(table).toHaveTextContent("gpt-4o");
});

test("generated code is shown prominently with a diff summary and copy control", async () => {
  pipelineResp = resp(200, runResp({ outcome: "allow" }));
  render(<CodeFactoryPage />);
  await submitPrompt();
  await waitFor(() => expect(screen.getByTestId("generated-code")).toBeInTheDocument());
  // the actual generated code is visible (not hidden behind a collapsed details)
  expect(screen.getByTestId("generated-code")).toHaveTextContent("const k = 1;");
  // header summarises the change (+1 added from the mock diff) and offers copy
  expect(screen.getByTestId("generated-code-stats")).toHaveTextContent("+1");
  expect(screen.getByTestId("copy-code")).toBeInTheDocument();
});

test("protected panel shows what the gate caught, by class, from mount", async () => {
  historyResp = resp(200, {
    runs: [], grade: { total: 0, readyRate: 0, firstPassRate: 0, blockRate: 0, escalationRate: 0, byModel: [] }, drift: [],
    protected: { totalCaught: 5, byClass: [{ klass: "logged_credential", label: "Secret written to a log", count: 3 }, { klass: "sql_injection", label: "SQL injection", count: 2 }], changesBlocked: 2, sentForReview: 1, criticalsCaught: 4, windowDays: 30 },
  });
  render(<CodeFactoryPage />);
  await waitFor(() => expect(screen.getByTestId("protected-summary")).toBeInTheDocument());
  expect(screen.getByText("Protected from production issues")).toBeInTheDocument();
  expect(screen.getByTestId("protected-summary")).toHaveTextContent("5"); // issues caught
  const byClass = screen.getByTestId("protected-by-class");
  expect(byClass).toHaveTextContent("Secret written to a log");
  expect(byClass).toHaveTextContent("SQL injection");
});
