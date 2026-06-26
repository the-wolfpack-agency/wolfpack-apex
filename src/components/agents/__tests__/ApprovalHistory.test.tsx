/** @jest-environment jsdom */
import "@testing-library/jest-dom";

/**
 * ApprovalHistory: the read-only human-in-the-loop history (recent decided
 * approvals) for one agent. Renders decided rows with their status + summary +
 * when; stays quiet (renders nothing) when there is no history so the pending
 * list's own empty state speaks.
 */
const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { render, screen, waitFor } from "@testing-library/react";
import ApprovalHistory from "@/components/agents/ApprovalHistory";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mkRes = (body: unknown): any => ({ ok: true, status: 200, json: async () => body });

const DECIDED = {
  id: "h-1", agentId: "agent-9", ownerUserId: "owner-1", tool: "create_external_record",
  params: { objectType: "contact", fields: { Name: "Jane Doe" } },
  capability: "*", decisionSeq: 7, createdAt: "t", status: "executed", decidedAt: "2026-06-26T19:00:00Z",
};

it("renders recent decisions with status + summary from the history endpoint", async () => {
  mockFetchWithRefresh.mockResolvedValue(mkRes({ approvals: [], history: [DECIDED] }));
  render(<ApprovalHistory agentId="agent-9" />);

  await screen.findByTestId("approval-history-h-1");
  expect(mockFetchWithRefresh).toHaveBeenCalledWith("/api/admin/agents/approvals?agentId=agent-9&history=1");
  const row = screen.getByTestId("approval-history-h-1");
  expect(row).toHaveTextContent(/executed/i);
  expect(row).toHaveTextContent("Contact · Name=Jane Doe");
});

it("renders nothing when there is no decided history", async () => {
  mockFetchWithRefresh.mockResolvedValue(mkRes({ approvals: [], history: [] }));
  const { container } = render(<ApprovalHistory agentId="agent-9" />);
  await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalled());
  expect(screen.queryByTestId("agent-approvals-history")).toBeNull();
  expect(container).toBeEmptyDOMElement();
});
