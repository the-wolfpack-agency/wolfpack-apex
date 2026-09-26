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

const FINDING = {
  file: "lib/x.ts", line: 2, klass: "logged_credential", severity: "critical", cwe: "CWE-532",
  title: "Possible credential written to a log (resetUrl)", detail: "A reset link reached a log.",
};
const EXECUTOR = { diff: "diff --git a/lib/x.ts b/lib/x.ts", author: "gpt-4o-mini", provider: "azure-openai", costUsd: 0.0003, latencyMs: 800, error: null };

function runResp(over: Partial<{ outcome: string; status: string; findings: unknown[]; judgments?: unknown[]; invariants: unknown; deepScan: unknown; approvalId: string | null }> = {}) {
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
      openQuestions: [],
    },
    approvalId: over.approvalId !== undefined ? over.approvalId : outcome === "allow" ? "appr-1" : null,
    executor: EXECUTOR,
    invariants: over.invariants ?? { ruleId: "R-MUTATION-ALLOW", intendedOutcome: "allow", wouldBlock: false, reason: "ok" },
    deepScan: over.deepScan ?? { scanned: 1, critical: 0, high: 0, blocking: false },
  };
}

async function submitPrompt(text = "add isPalindrome with tests") {
  fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: text } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /generate & gate/i })); });
}

beforeEach(() => { jest.clearAllMocks(); user = { role: "cto" }; });

test("redirects an unauthenticated user to login, never a blank page", () => {
  user = null;
  render(<CodeFactoryPage />);
  expect(mockPush).toHaveBeenCalledWith("/login?next=/admin/ai-code");
});

test("submits a PROMPT (no diff) to the pipeline and shows the executor + allow verdict", async () => {
  mockFetch.mockResolvedValue(resp(200, runResp({ outcome: "allow" })));
  render(<CodeFactoryPage />);
  await submitPrompt();
  // it posted a prompt, not a diff
  const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body);
  expect(body.prompt).toContain("isPalindrome");
  expect(body).not.toHaveProperty("diff");
  expect(mockFetch.mock.calls[0][0]).toBe("/api/admin/ai-code/pipeline");
  // executor + verdict render
  await waitFor(() => expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument());
  expect(screen.getByText(/Allowed/)).toBeInTheDocument();
  expect(screen.getAllByText(/Ready for PR/).length).toBeGreaterThan(0); // verdict pill + handoff status
});

test("shows a block verdict with the finding, and needs-human status", async () => {
  mockFetch.mockResolvedValue(resp(200, runResp({ outcome: "block", findings: [FINDING] })));
  render(<CodeFactoryPage />);
  await submitPrompt();
  await waitFor(() => expect(screen.getByText(/Blocked - do not merge/)).toBeInTheDocument());
  expect(screen.getByText(/credential written to a log/i)).toBeInTheDocument();
  expect(screen.getAllByText(/Needs human/).length).toBeGreaterThan(0); // verdict pill + handoff status
});

test("shows the independent judge only when judgments are present", async () => {
  mockFetch.mockResolvedValue(
    resp(200, runResp({
      outcome: "escalate",
      findings: [FINDING],
      judgments: [{ finding: FINDING, verdict: "confirmed", authorLineage: "openai", judgeLineage: "anthropic", reason: "real issue" }],
    })),
  );
  render(<CodeFactoryPage />);
  await submitPrompt();
  await waitFor(() => expect(screen.getByText(/Independent judge/)).toBeInTheDocument());
  expect(screen.getByText(/judged by anthropic/)).toBeInTheDocument();
});

test("surfaces a 422 (executor produced no diff) honestly, without a run", async () => {
  mockFetch.mockResolvedValue(resp(422, { error: "executor produced no diff", executor: { ...EXECUTOR, diff: "", error: null } }));
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
  expect(mockFetch).not.toHaveBeenCalled();
});

test("governance panel: clean invariants + deep scan, handoff captured", async () => {
  mockFetch.mockResolvedValue(resp(200, runResp({ outcome: "allow" })));
  render(<CodeFactoryPage />);
  await submitPrompt();
  await waitFor(() => expect(screen.getByTestId("governance-panel")).toBeInTheDocument());
  expect(screen.getByText(/Invariants: clear/)).toBeInTheDocument();
  expect(screen.getByText(/Deep scan: clean/)).toBeInTheDocument();
  expect(screen.getByTestId("handoff-status")).toHaveTextContent(/handoff captured/i);
});

test("governance panel: an invariant blocks -> withheld from handoff", async () => {
  mockFetch.mockResolvedValue(
    resp(200, runResp({
      outcome: "allow",
      approvalId: null, // withheld
      invariants: { ruleId: "R-DEPENDENCY-ADDED-ESCALATE", intendedOutcome: "escalate", wouldBlock: true, reason: "adds a runtime dependency" },
    })),
  );
  render(<CodeFactoryPage />);
  await submitPrompt();
  await waitFor(() => expect(screen.getByTestId("handoff-status")).toHaveTextContent(/Withheld from PR handoff: R-DEPENDENCY-ADDED-ESCALATE/));
  expect(screen.getByText(/Invariant: R-DEPENDENCY-ADDED-ESCALATE/)).toBeInTheDocument();
});

test("governance panel: a critical deep-scan finding -> withheld from handoff", async () => {
  mockFetch.mockResolvedValue(
    resp(200, runResp({
      outcome: "allow",
      approvalId: null,
      deepScan: { scanned: 1, critical: 1, high: 0, blocking: true },
    })),
  );
  render(<CodeFactoryPage />);
  await submitPrompt();
  await waitFor(() => expect(screen.getByText(/Deep scan: 1 critical/)).toBeInTheDocument());
  expect(screen.getByTestId("handoff-status")).toHaveTextContent(/critical security finding/);
});
