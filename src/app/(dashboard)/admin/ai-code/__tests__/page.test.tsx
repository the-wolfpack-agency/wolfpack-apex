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

import CodeGatePage from "../page";

function resp(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}
const FINDING = {
  file: "lib/x.ts", line: 2, klass: "logged_credential", severity: "critical", cwe: "CWE-532",
  title: "Possible credential written to a log (resetUrl)", detail: "A reset link reached a log.",
};
const blockResult = {
  result: {
    ref: "PR-1", author: "cursor", findings: [FINDING],
    verdict: { outcome: "block", highestSeverity: "critical", reason: "a critical risk was introduced", ruleId: "C-CRITICAL-BLOCK" },
    bySeverity: { critical: 1 },
  },
};

async function submitDiff() {
  fireEvent.change(screen.getByLabelText("Unified diff"), { target: { value: "diff --git a/x b/x" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /review/i })); });
}

beforeEach(() => { jest.clearAllMocks(); user = { role: "cto" }; });

test("blocks a diff and renders the verdict + finding", async () => {
  mockFetch.mockResolvedValue(resp(200, blockResult));
  render(<CodeGatePage />);
  await submitDiff();
  await waitFor(() => expect(screen.getByText(/Blocked - do not merge/)).toBeInTheDocument());
  expect(screen.getByText(/credential written to a log/i)).toBeInTheDocument();
  expect(screen.getByText(/lib\/x\.ts:2/)).toBeInTheDocument();
});

test("shows the independent judge section only when judgments are present", async () => {
  mockFetch.mockResolvedValue(resp(200, {
    result: { ...blockResult.result, judgments: [{ finding: FINDING, verdict: "confirmed", authorLineage: "openai", judgeLineage: "anthropic", reason: "real issue" }] },
  }));
  render(<CodeGatePage />);
  await submitDiff();
  await waitFor(() => expect(screen.getByText("Independent judge")).toBeInTheDocument());
  expect(screen.getByText(/judged by anthropic/)).toBeInTheDocument();
  expect(screen.getByText("Confirmed")).toBeInTheDocument();
});

test("allows a clean diff", async () => {
  mockFetch.mockResolvedValue(resp(200, {
    result: { ref: "manual", author: "unknown", findings: [], verdict: { outcome: "allow", highestSeverity: "none", reason: "no security findings", ruleId: "C-CLEAN-ALLOW" }, bySeverity: {} },
  }));
  render(<CodeGatePage />);
  await submitDiff();
  await waitFor(() => expect(screen.getByText("Allowed")).toBeInTheDocument());
  expect(screen.getByText(/No security findings/)).toBeInTheDocument();
});

test("redirects an unauthenticated user to /login", () => {
  user = null;
  render(<CodeGatePage />);
  expect(mockPush).toHaveBeenCalledWith("/login?next=/admin/ai-code");
});

test("refuses to submit an empty diff", async () => {
  render(<CodeGatePage />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /review/i })); });
  expect(screen.getByRole("alert")).toHaveTextContent(/Paste a diff/);
  expect(mockFetch).not.toHaveBeenCalled();
});
