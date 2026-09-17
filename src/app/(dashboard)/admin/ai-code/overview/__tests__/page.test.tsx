/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));

const mockFetch = jest.fn();
let user: unknown = { role: "member" };
jest.mock("@/lib/client-auth", () => ({
  getInstinctUser: () => user,
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
}));

import CodeGovernancePage from "../page";

function resp(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const REVIEWS = [
  { id: "1", ref: "PR-10", author: "cursor", outcome: "block", highestSeverity: "critical", findingCount: 2, createdAt: "2026-09-17T00:00:00.000Z" },
  { id: "2", ref: "PR-11", author: "copilot", outcome: "escalate", highestSeverity: "high", findingCount: 1, createdAt: "2026-09-16T00:00:00.000Z" },
  { id: "3", ref: "PR-12", author: "devin", outcome: "allow", highestSeverity: "none", findingCount: 0, createdAt: "2026-09-15T00:00:00.000Z" },
];

beforeEach(() => {
  jest.clearAllMocks();
  user = { role: "member" };
});

test("renders the trust checklist and the aggregate the workspace's reviews add up to", async () => {
  mockFetch.mockResolvedValue(resp(200, { reviews: REVIEWS }));
  render(<CodeGovernancePage />);

  // The plain-language checklist every change goes through (4 items).
  await waitFor(() => expect(screen.getAllByTestId("check-row")).toHaveLength(4));
  expect(screen.getByText(/Secrets & credentials/)).toBeInTheDocument();
  expect(screen.getByText(/Independent review/)).toBeInTheDocument();

  // Aggregates: 3 governed, 1 blocked, 1 needs-review, 3 risks caught (2 + 1 on the non-allowed).
  await waitFor(() => expect(screen.getByTestId("metric-governed")).toHaveTextContent("3"));
  expect(screen.getByTestId("metric-blocked")).toHaveTextContent("1");
  expect(screen.getByTestId("metric-review")).toHaveTextContent("1");
  expect(screen.getByTestId("metric-caught")).toHaveTextContent("3");

  // One row per governed change, with a plain-language outcome.
  expect(screen.getAllByTestId("gov-row")).toHaveLength(3);
  // "Blocked" is also a metric label, so assert its outcome pill among the rows.
  expect(screen.getAllByText("Blocked").length).toBeGreaterThanOrEqual(1);
  expect(screen.getByText("Needs review")).toBeInTheDocument();
  expect(screen.getByText("Allowed")).toBeInTheDocument();
  expect(screen.getByText("PR-10")).toBeInTheDocument();
});

test("shows an explicit empty state when nothing has been governed yet", async () => {
  mockFetch.mockResolvedValue(resp(200, { reviews: [] }));
  render(<CodeGovernancePage />);
  await waitFor(() => expect(screen.getByTestId("gov-empty")).toBeInTheDocument());
  expect(screen.getByTestId("metric-governed")).toHaveTextContent("0");
});

test("redirects an unauthenticated user to login instead of rendering an empty shell", () => {
  user = null;
  render(<CodeGovernancePage />);
  expect(mockPush).toHaveBeenCalledWith("/login?next=/admin/ai-code/overview");
  expect(mockFetch).not.toHaveBeenCalled();
});
