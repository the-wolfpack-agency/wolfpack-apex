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

function runResp(over: Partial<{ outcome: string; status: string; findings: unknown[]; judgments?: unknown[]; invariants: unknown; deepScan: unknown; duplication: unknown; approvalId: string | null; openQuestions: unknown[] }> = {}) {
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
    duplication: over.duplication ?? { escalate: false, candidatePath: null, score: 0, reason: null },
    cost: { actualUsd: 0.0003, inputTokens: 500, outputTokens: 800, attempts: 1, comparison: [{ model: "gpt-4o-mini", provider: "openai", tier: "small", costUsd: 0.000555 }, { model: "gpt-4o", provider: "openai", tier: "large", costUsd: 0.00925 }] },
  };
}

async function submitPrompt(text = "add isPalindrome with tests") {
  fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: text } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /generate & gate/i })); });
}

test("readiness preflight: renders the checks and a one-click fix link for a blocker", async () => {
  render(<CodeFactoryPage />);
  fireEvent.change(screen.getByTestId("repo-input"), { target: { value: "acme/site" } });
  await act(async () => { fireEvent.click(screen.getByTestId("check-readiness")); });
  await waitFor(() => expect(screen.getByTestId("readiness-checks")).toBeInTheDocument());
  // The warn on automatic-PRs surfaces its one-click install fix (the exact
  // blocker that caused the mid-flow 403), so the user resolves it up front.
  const fix = screen.getByTestId("readiness-fix-pr-capability");
  expect(fix).toHaveAttribute("href", "https://github.com/apps/agentgate-ai/installations/new");
  expect(screen.getByTestId("readiness-overall")).toHaveTextContent(/ready, with notes/i);
});

let pipelineResp: Response;
let planResp: Response;
let brainResp: Response;
let efficacyResp: Response;
let approveResp: Response;
let historyResp: Response;
let auditResp: Response;
let ciResp: Response;
let readinessResp: Response;
beforeEach(() => {
  jest.clearAllMocks();
  user = { role: "cto" };
  pipelineResp = resp(200, runResp({ outcome: "allow" }));
  planResp = resp(200, { plan: { goal: "g", truncated: false, model: "test-model", steps: [
    { id: "step-1", title: "Add schema", instruction: "Create the quotas table", rationale: "foundation", sensitive: true },
    { id: "step-2", title: "Add API", instruction: "Add the rate-limit route", rationale: "uses schema", sensitive: false },
  ] } });
  brainResp = resp(200, { reuseCorpus: { total: 128 }, failureMemory: { total: 9 } });
  efficacyResp = resp(200, { efficacy: { windowDays: 30, runs: 12, firstPassReadyRate: 0.75, acceptanceRate: 0.6, duplicationRate: 0.1, reuseSemanticRate: 0.5, repeatFindingRate: 0.25, readyTrend: "up" } });
  approveResp = resp(200, { ok: true, status: "executed", outcome: { ok: true, url: "https://github.com/o/r/pull/42", number: 42 } });
  historyResp = HISTORY_EMPTY();
  auditResp = resp(200, { verification: { ok: true, verifiedCount: 7, legacyCount: 0, brokenAtSeq: null, headSeq: 7, headHash: "h" }, entries: [{ seq: 7, created_at: "2026-09-27T10:00:00Z", principal_agent: "instinct.ai_code", intended_outcome: "allow", effective_outcome: "allow", would_block: false, rule_id: "R-MUTATION-ALLOW", reason: null }], entryCount: 1, generatedAtIso: "2026-09-27T10:00:00.000Z" });
  ciResp = resp(200, { dashboard: { categories: [{ key: "unit", label: "Unit tests", status: "pass", passed: 3, failed: 0, pending: 0, checks: ["unit"] }, { key: "security", label: "Security", status: "fail", passed: 0, failed: 1, pending: 0, checks: ["scan"] }], overall: "fail", summary: { total: 4, passed: 3, failed: 1, pending: 0 } } });
  readinessResp = resp(200, { readiness: { overall: "warn", ready: true, fullyReady: false, checks: [
    { id: "github-access", label: "GitHub access", status: "pass", detail: "A credential is available." },
    { id: "pr-capability", label: "Automatic pull requests", status: "warn", detail: "Using the shared token. Install the App to guarantee automatic PRs.", fix: { label: "Connect GitHub (one-click install)", url: "https://github.com/apps/agentgate-ai/installations/new" } },
  ] } });
  // URL-aware: the page fetches run history on mount and after each run; route it
  // to an empty history so it never consumes a per-test response. Everything else
  // is the pipeline unless it targets the approvals endpoint.
  mockFetch.mockImplementation((url: string) => {
    const u = String(url);
    if (u.includes("/ai-code/history")) return Promise.resolve(historyResp);
    if (u.includes("/ai-code/audit")) return Promise.resolve(auditResp);
    if (u.includes("/ai-code/readiness")) return Promise.resolve(readinessResp);
    if (u.includes("/ai-code/ci")) return Promise.resolve(ciResp);
    if (u.includes("/ai-code/plan")) return Promise.resolve(planResp);
    if (u.includes("/ai-code/efficacy")) return Promise.resolve(efficacyResp);
    if (u.includes("/ai-code/brain")) return Promise.resolve(brainResp);
    if (u.includes("/api/analytics")) return Promise.resolve(resp(200, { ok: true }));
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

test("governance panel: the DRY gate flags a likely duplication -> withheld from handoff", async () => {
  pipelineResp = resp(200, runResp({
      outcome: "allow",
      status: "needs_human",
      approvalId: null,
      duplication: {
        escalate: true,
        candidatePath: "src/lib/cost-summary.ts",
        score: 8,
        reason: "This change does not import src/lib/cost-summary.ts, whose name strongly matches the task. It likely re-implements capability that already exists - reuse or extend it.",
      },
    }));
  render(<CodeFactoryPage />);
  await submitPrompt();
  await waitFor(() => expect(screen.getByText(/Reuse: possible duplication/)).toBeInTheDocument());
  expect(screen.getByTestId("duplication-reason")).toHaveTextContent(/cost-summary\.ts/);
  // The DRY gate set the run to needs_human, so the handoff is withheld.
  expect(screen.getByTestId("handoff-status")).toHaveTextContent(/Needs human|did not allow/i);
  expect(screen.queryByTestId("approve-open-pr")).not.toBeInTheDocument();
});

test("approve & open PR: clicking approve opens the real PR and shows the link", async () => {
  approveResp = resp(200, { ok: true, status: "executed", outcome: { ok: true, url: "https://github.com/o/r/pull/42", number: 42 } });
  render(<CodeFactoryPage />);
  await submitPrompt();
  await waitFor(() => expect(screen.getByTestId("approve-open-pr")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("approve-consent")); // human-in-the-gate consent
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
  fireEvent.click(screen.getByTestId("approve-consent")); // human-in-the-gate consent
  await act(async () => { fireEvent.click(screen.getByTestId("approve-open-pr")); });
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/no GitHub token/));
  expect(screen.queryByTestId("pr-link")).not.toBeInTheDocument();
});

test("a PR-permission failure shows a one-click compare link so the pushed work is not lost", async () => {
  approveResp = resp(200, {
    ok: false,
    status: "executed",
    outcome: {
      ok: false,
      reason: 'The change was pushed to branch "factory/x-abc", but this GitHub token cannot open pull requests. Install the Instinct GitHub App.',
      branch: "factory/x-abc",
      compareUrl: "https://github.com/o/r/compare/main...factory/x-abc?expand=1",
    },
  });
  render(<CodeFactoryPage />);
  await submitPrompt();
  await waitFor(() => expect(screen.getByTestId("approve-open-pr")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("approve-consent"));
  await act(async () => { fireEvent.click(screen.getByTestId("approve-open-pr")); });
  await waitFor(() => expect(screen.getByTestId("compare-link")).toBeInTheDocument());
  expect(screen.getByTestId("compare-link")).toHaveAttribute("href", "https://github.com/o/r/compare/main...factory/x-abc?expand=1");
  expect(screen.getByRole("alert")).toHaveTextContent(/GitHub App/);
});

test("a permission failure offers the one-click GitHub App install when the App URL is configured", async () => {
  process.env.NEXT_PUBLIC_GITHUB_APP_INSTALL_URL = "https://github.com/apps/instinct/installations/new";
  approveResp = resp(200, {
    ok: false,
    status: "executed",
    outcome: {
      ok: false,
      reason: 'The change was pushed to branch "factory/x-abc", but this GitHub token cannot open pull requests. Install the Instinct GitHub App.',
      branch: "factory/x-abc",
      compareUrl: "https://github.com/o/r/compare/main...factory/x-abc?expand=1",
      needsInstall: true,
    },
  });
  render(<CodeFactoryPage />);
  await submitPrompt();
  await waitFor(() => expect(screen.getByTestId("approve-open-pr")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("approve-consent"));
  await act(async () => { fireEvent.click(screen.getByTestId("approve-open-pr")); });
  await waitFor(() => expect(screen.getByTestId("connect-github")).toBeInTheDocument());
  expect(screen.getByTestId("connect-github")).toHaveAttribute("href", "https://github.com/apps/instinct/installations/new");
  delete process.env.NEXT_PUBLIC_GITHUB_APP_INSTALL_URL;
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

test("clarifier: a FRESH submit clears prior answers so every question re-opens (regression: the tests section stopped reappearing)", async () => {
  pipelineResp = resp(200, runResp({ outcome: "allow", openQuestions: OPEN_Q }));
  render(<CodeFactoryPage />);
  // First run: answer the tests question and re-run with it.
  await submitPrompt();
  await waitFor(() => expect(screen.getByTestId("clarifier-tests")).toBeInTheDocument());
  fireEvent.change(screen.getByTestId("clarifier-tests"), { target: { value: "all" } });
  await act(async () => { fireEvent.click(screen.getByTestId("clarifier-rerun")); });

  // Now a FRESH submission (the main Generate button), as if adding more code.
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /generate & gate/i })); });

  // The fresh run must NOT carry the stale answer - it sends answers=undefined so
  // the clarifier re-opens the tests question against the new prompt.
  const pipelineCalls = mockFetch.mock.calls.filter((c) => c[0] === "/api/admin/ai-code/pipeline");
  const lastBody = JSON.parse((pipelineCalls[pipelineCalls.length - 1][1] as { body: string }).body);
  expect(lastBody.answers).toBeUndefined();
  // And the clarifier is still on screen (the section did not vanish).
  await waitFor(() => expect(screen.getByTestId("clarifier-tests")).toBeInTheDocument());
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

test("history rows expand to show the actual code change, with clear status pills", async () => {
  historyResp = resp(200, {
    runs: [
      { ref: "feat-wordstats-1", model: "gpt-4o-mini", status: "ready_for_pr", attempts: 0, finalOutcome: "allow", deepScanCritical: 0, conforms: true, createdAt: "2026-09-27T10:00:00Z", reason: "no findings", diff: "diff --git a/src/lib/x.ts b/src/lib/x.ts\n+export const x = 1;" },
    ],
    grade: { total: 1, readyRate: 1, firstPassRate: 1, blockRate: 0, escalationRate: 0, byModel: [] },
    drift: [],
  });
  render(<CodeFactoryPage />);
  await waitFor(() => expect(screen.getByTestId("history-runs")).toBeInTheDocument());
  // ready/allow render as status pills (not dead buttons): the label text is present.
  expect(screen.getByTestId("history-runs")).toHaveTextContent("Ready for PR");
  expect(screen.getByTestId("history-runs")).toHaveTextContent(/Allowed|allow/i);
  // the row is clickable and reveals the actual code change on expand.
  expect(screen.queryByTestId("history-run-detail-0")).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId("history-run-0"));
  const detail = await screen.findByTestId("history-run-detail-0");
  expect(detail).toHaveTextContent("export const x = 1;");
  expect(detail).toHaveTextContent(/Gate verdict:.*no findings/i);
});

test("the 'awaiting your production decision' callout shows a clickable preview URL", async () => {
  historyResp = resp(200, {
    runs: [], grade: { total: 0, readyRate: 0, firstPassRate: 0, blockRate: 0, escalationRate: 0, byModel: [] }, drift: [],
    gateSafety: {
      total: 1, allowed: 0, autoFixed: 0, escalatedToHuman: 1, badChangesPrevented: 0, dataKeptFromModel: 1,
      frameworks: [], recent: [], awaitingProd: [{ previewUrl: "https://preview-abc.vercel.app", recordedSeq: 21, createdAt: "2026-09-28T10:00:00Z" }],
    },
  });
  render(<CodeFactoryPage />);
  await waitFor(() => expect(screen.getByTestId("awaiting-prod")).toBeInTheDocument());
  const link = screen.getByRole("link", { name: /preview-abc\.vercel\.app/ });
  expect(link).toHaveAttribute("href", "https://preview-abc.vercel.app");
  expect(screen.getByTestId("awaiting-prod")).toHaveTextContent(/ledger #21/);
});

test("a history run with no stored diff says so instead of a dead click", async () => {
  historyResp = resp(200, {
    runs: [{ ref: "old-run", model: "claude", status: "ready_for_pr", attempts: 0, finalOutcome: "allow", deepScanCritical: 0, conforms: true, createdAt: "2026-09-20T10:00:00Z" }],
    grade: { total: 1, readyRate: 1, firstPassRate: 1, blockRate: 0, escalationRate: 0, byModel: [] },
    drift: [],
  });
  render(<CodeFactoryPage />);
  await waitFor(() => expect(screen.getByTestId("history-run-0")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("history-run-0"));
  expect(await screen.findByTestId("history-run-detail-0")).toHaveTextContent(/No stored code change/i);
});

test("the 'How we kept you safe' panel renders the gate-safety metrics + a verifiable decision list", async () => {
  historyResp = resp(200, {
    runs: [], grade: { total: 0, readyRate: 0, firstPassRate: 0, blockRate: 0, escalationRate: 0, byModel: [] }, drift: [],
    gateSafety: {
      total: 3, allowed: 1, autoFixed: 1, escalatedToHuman: 1, badChangesPrevented: 1, dataKeptFromModel: 2,
      frameworks: ["SOC2", "GDPR"],
      recent: [
        { gate: "safe-review", verdict: "deny", modelInvoked: null, findings: 1, recordedSeq: 11, createdAt: "2026-09-28T10:00:00Z", previewUrl: null },
        { gate: "ci-autofix", verdict: "auto_fix", modelInvoked: "gpt-4o-mini", findings: 0, recordedSeq: 12, createdAt: "2026-09-28T09:00:00Z", previewUrl: null },
      ],
      awaitingProd: [],
    },
  });
  render(<CodeFactoryPage />);
  await waitFor(() => expect(screen.getByTestId("gate-safety")).toBeInTheDocument());
  const panel = screen.getByTestId("gate-safety");
  expect(panel).toHaveTextContent("Data kept from the LLM");
  expect(panel).toHaveTextContent("Bad changes prevented");
  expect(screen.getByTestId("gate-safety-frameworks")).toHaveTextContent(/SOC2, GDPR/);
  // a rejection IS shown, with its verdict pill + that no model saw the data + the ledger seq
  const recent = screen.getByTestId("gate-safety-recent");
  expect(recent).toHaveTextContent("safe-review");
  expect(recent).toHaveTextContent(/Blocked/);
  expect(recent).toHaveTextContent(/no model - data kept in/);
  expect(recent).toHaveTextContent(/ledger #11/);
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
  fireEvent.click(screen.getByTestId("approve-consent")); // human-in-the-gate consent
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
  // and reports the line count of the generated code (net +1 -> "1 line")
  expect(screen.getByTestId("generated-code-linecount")).toHaveTextContent("1 line");
  expect(screen.getByTestId("copy-code")).toBeInTheDocument();
});

test("protected panel shows what the gate caught, by class, from mount", async () => {
  historyResp = resp(200, {
    runs: [], grade: { total: 0, readyRate: 0, firstPassRate: 0, blockRate: 0, escalationRate: 0, byModel: [] }, drift: [],
    protected: { totalCaught: 5, byClass: [{ klass: "logged_credential", label: "Secret written to a log", count: 3 }, { klass: "sql_injection", label: "SQL injection", count: 2 }], changesBlocked: 2, sentForReview: 1, criticalsCaught: 4, prsOpened: 8, prsMerged: 6, prsClosedUnmerged: 2, acceptanceRate: 0.75, windowDays: 30 },
  });
  render(<CodeFactoryPage />);
  await waitFor(() => expect(screen.getByTestId("protected-summary")).toBeInTheDocument());
  expect(screen.getByText("Protected from production issues")).toBeInTheDocument();
  expect(screen.getByTestId("protected-summary")).toHaveTextContent("5"); // issues caught
  const byClass = screen.getByTestId("protected-by-class");
  expect(byClass).toHaveTextContent("Secret written to a log");
  expect(byClass).toHaveTextContent("SQL injection");
  // ROI/adoption outcomes: did the factory's work actually ship?
  const outcomes = screen.getByTestId("protected-outcomes");
  expect(outcomes).toHaveTextContent("PRs opened");
  expect(outcomes).toHaveTextContent("8"); // opened
  expect(outcomes).toHaveTextContent("75%"); // acceptance rate (6/8)
});

test("human-in-the-gate: the approve button is disabled until consent is given, and nothing touches GitHub before then", async () => {
  pipelineResp = resp(200, runResp({ outcome: "allow" }));
  render(<CodeFactoryPage />);
  await submitPrompt();
  await waitFor(() => expect(screen.getByTestId("approve-open-pr")).toBeInTheDocument());
  // gated: disabled before consent, and clicking it does not call the approval endpoint
  expect(screen.getByTestId("approve-open-pr")).toBeDisabled();
  await act(async () => { fireEvent.click(screen.getByTestId("approve-open-pr")); });
  expect(approvalCall()).toBeUndefined(); // no GitHub-touching call yet
  // consent enables it
  fireEvent.click(screen.getByTestId("approve-consent"));
  expect(screen.getByTestId("approve-open-pr")).not.toBeDisabled();
});

test("audit evidence: verifying the chain shows a tamper-evident verdict and offers a download", async () => {
  render(<CodeFactoryPage />);
  await act(async () => { fireEvent.click(screen.getByTestId("verify-audit")); });
  await waitFor(() => expect(screen.getByTestId("audit-result")).toBeInTheDocument());
  expect(screen.getByTestId("audit-verdict")).toHaveTextContent(/tamper-evident chain verified/i);
  expect(screen.getByTestId("audit-verdict")).toHaveTextContent("7");
  expect(screen.getByTestId("download-audit")).toBeInTheDocument();
  expect(screen.getByTestId("audit-entries")).toHaveTextContent("R-MUTATION-ALLOW");
});

test("in-app help: a How it works guide explains the flow for a new user", async () => {
  render(<CodeFactoryPage />);
  await waitFor(() => expect(screen.getByTestId("how-it-works")).toBeInTheDocument());
  const help = screen.getByTestId("how-it-works");
  expect(help).toHaveTextContent(/describe the change/i);
  expect(help).toHaveTextContent(/pull request open on your repo/i);
  expect(help).toHaveTextContent(/build & deploy checkpoints/i);
  expect(help).toHaveTextContent(/tamper-evident audit/i);
});

test("per-site selector: lists the sites the factory built against and scopes history to one", async () => {
  historyResp = resp(200, {
    runs: [
      { ref: "feat-alloc-1", model: "gpt-4o-mini", status: "ready_for_pr", attempts: 0, finalOutcome: "allow", deepScanCritical: 0, conforms: true, createdAt: "2026-09-30T10:00:00Z", repo: "the-wolfpack-agency/wolfpack-ford" },
    ],
    repos: ["(self)", "the-wolfpack-agency/wolfpack-ford"],
    repo: null,
    grade: { total: 1, readyRate: 1, firstPassRate: 1, blockRate: 0, escalationRate: 0, byModel: [] },
    drift: [],
  });
  render(<CodeFactoryPage />);
  // the selector renders with every site, and a run shows its site chip
  await waitFor(() => expect(screen.getByTestId("site-select")).toBeInTheDocument());
  expect(screen.getByTestId("site-select")).toHaveTextContent("wolfpack-ford");
  expect(screen.getByTestId("history-run-repo-0")).toHaveTextContent("wolfpack-ford");
  // choosing a site re-pulls history scoped to that repo
  await act(async () => {
    fireEvent.change(screen.getByTestId("site-select"), { target: { value: "the-wolfpack-agency/wolfpack-ford" } });
  });
  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some((c) => String(c[0]).includes("/ai-code/history") && String(c[0]).includes("repo=the-wolfpack-agency%2Fwolfpack-ford")),
    ).toBe(true),
  );
});

test("iterative refinement: Refine re-runs the pipeline with refineOf = the prior diff", async () => {
  pipelineResp = resp(200, runResp({ outcome: "allow" }));
  render(<CodeFactoryPage />);
  await submitPrompt();
  await waitFor(() => expect(screen.getByTestId("generated-code")).toBeInTheDocument());
  fireEvent.change(screen.getByTestId("refine-instruction"), { target: { value: "also handle the empty string" } });
  await act(async () => { fireEvent.click(screen.getByTestId("refine-run")); });
  const calls = mockFetch.mock.calls.filter((c) => c[0] === "/api/admin/ai-code/pipeline");
  const body = JSON.parse((calls[calls.length - 1][1] as { body: string }).body);
  expect(body.refineOf).toContain("diff --git a/lib/x.ts");
  expect(body.prompt).toBe("also handle the empty string");
});

test("multi-step planning: proposes steps and launching one fills the prompt (propose-only, nothing runs)", async () => {
  render(<CodeFactoryPage />);
  fireEvent.change(screen.getByTestId("plan-goal"), { target: { value: "add per-tenant rate limiting with an admin view" } });
  await act(async () => { fireEvent.click(screen.getByTestId("plan-propose")); });

  // Both proposed steps render; the schema step is flagged sensitive.
  await waitFor(() => expect(screen.getByTestId("plan-steps")).toBeInTheDocument());
  expect(screen.getByTestId("plan-step-step-1")).toHaveTextContent("Add schema");
  expect(screen.getByTestId("plan-step-sensitive-step-1")).toBeInTheDocument();
  expect(screen.getByTestId("plan-step-step-2")).toHaveTextContent("Add API");

  // Proposing must NOT have run the pipeline (propose-only).
  expect(mockFetch.mock.calls.some((c) => c[0] === "/api/admin/ai-code/pipeline")).toBe(false);

  // Launching a step fills the main prompt + fires the human-in-the-loop event,
  // but still does not run the pipeline - the human clicks Generate next.
  await act(async () => { fireEvent.click(screen.getByTestId("plan-step-launch-step-2")); });
  expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Add the rate-limit route");
  const analyticsCall = mockFetch.mock.calls.find((c) => String(c[0]).includes("/api/analytics"));
  expect(analyticsCall).toBeTruthy();
  expect(JSON.parse((analyticsCall![1] as { body: string }).body).event).toBe("ai_code.plan_step_launched");
  expect(mockFetch.mock.calls.some((c) => c[0] === "/api/admin/ai-code/pipeline")).toBe(false);
});

test("multi-step planning: a model/parse failure shows a friendly error, not a crash", async () => {
  planResp = resp(200, { plan: { goal: "g", truncated: false, model: null, steps: [] } });
  render(<CodeFactoryPage />);
  fireEvent.change(screen.getByTestId("plan-goal"), { target: { value: "something vague" } });
  await act(async () => { fireEvent.click(screen.getByTestId("plan-propose")); });
  await waitFor(() => expect(screen.getByTestId("plan-error")).toBeInTheDocument());
});

test("reuse brain: shows the corpus size on mount and warming a repo updates it", async () => {
  brainResp = resp(200, { reuseCorpus: { total: 128 }, failureMemory: { total: 9 } });
  efficacyResp = resp(200, { efficacy: { windowDays: 30, runs: 12, firstPassReadyRate: 0.75, acceptanceRate: 0.6, duplicationRate: 0.1, reuseSemanticRate: 0.5, repeatFindingRate: 0.25, readyTrend: "up" } });
  render(<CodeFactoryPage />);
  await waitFor(() => expect(screen.getByTestId("brain-total")).toHaveTextContent("128"));

  // Warm a repo -> POST returns a new total, panel updates + notes the result.
  brainResp = resp(200, { written: 40, indexed: 40, total: 168 });
  fireEvent.change(screen.getByTestId("brain-repo"), { target: { value: "acme/app" } });
  await act(async () => { fireEvent.click(screen.getByTestId("brain-warm")); });
  await waitFor(() => expect(screen.getByTestId("brain-total")).toHaveTextContent("168"));
  expect(screen.getByTestId("brain-note")).toHaveTextContent(/\+40 paths persisted, 40 indexed/);
  const warmCall = mockFetch.mock.calls.find((c) => c[0] === "/api/admin/ai-code/brain" && (c[1] as { method?: string })?.method === "POST");
  expect(JSON.parse((warmCall![1] as { body: string }).body).repo).toBe("acme/app");
});

test("improving-over-time panel renders the efficacy rates + trend arrow", async () => {
  efficacyResp = resp(200, { efficacy: { windowDays: 30, runs: 12, firstPassReadyRate: 0.75, acceptanceRate: 0.6, duplicationRate: 0.1, reuseSemanticRate: 0.5, repeatFindingRate: 0.25, readyTrend: "up" } });
  render(<CodeFactoryPage />);
  await waitFor(() => expect(screen.getByTestId("efficacy-panel")).toBeInTheDocument());
  expect(screen.getByTestId("efficacy-panel")).toHaveTextContent("75%"); // first-pass ready
  expect(screen.getByTestId("efficacy-trend")).toHaveTextContent("↑"); // ready-rate rising
  expect(screen.getByTestId("efficacy-runs")).toHaveTextContent("12 runs");
});

test("improving-over-time panel is hidden until there are runs (no empty noise)", async () => {
  efficacyResp = resp(200, { efficacy: { windowDays: 30, runs: 0, firstPassReadyRate: null, acceptanceRate: null, duplicationRate: null, reuseSemanticRate: null, repeatFindingRate: null, readyTrend: "n/a" } });
  render(<CodeFactoryPage />);
  await waitFor(() => expect(screen.getByTestId("brain-readout")).toBeInTheDocument());
  expect(screen.queryByTestId("efficacy-panel")).toBeNull();
});
