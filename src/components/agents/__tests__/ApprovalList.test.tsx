/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * UI tests for the shared <ApprovalList> — the human-in-the-loop write surface
 * reused by the workspace queue and (scoped via ?agentId) the agent detail page.
 * Asserts: it loads from the given endpoint; renders the captured write summary;
 * approve POSTs the decision and drops the row in place while reporting the new
 * count; showAgent=false hides the "proposed by agent" line (detail-page mode);
 * a custom testIdPrefix namespaces the surface; the empty state renders.
 * fetchWithRefresh is mocked + routed by URL/method.
 */
const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ApprovalList from "@/components/agents/ApprovalList";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkRes(body: unknown, opts: { ok?: boolean; status?: number } = {}): any {
  return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body };
}
const APPROVALS = [
  {
    id: "ap-1", agentId: "agent-9", ownerUserId: "owner-1", tool: "create_external_record",
    params: { objectType: "contact", fields: { Name: "Jane Doe", Email: "jane@acme.com" }, connector: "wolfpack-auto" },
    capability: "*", decisionSeq: 7, createdAt: "t",
  },
];
function route(approvals: unknown[]) {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (url.startsWith("/api/admin/agents/approvals?") && !opts) return Promise.resolve(mkRes({ approvals }));
    if (url.startsWith("/api/admin/agents/approvals/") && opts?.method === "POST") return Promise.resolve(mkRes({ ok: true, status: "executed" }));
    return Promise.resolve(mkRes({}));
  });
}

beforeEach(() => jest.clearAllMocks());

it("loads from the scoped endpoint, renders the write summary, and hides the agent line in detail mode", async () => {
  route(APPROVALS);
  const onCount = jest.fn();
  render(
    <ApprovalList endpoint="/api/admin/agents/approvals?agentId=agent-9" showAgent={false} testIdPrefix="agent-approvals" onCountChange={onCount} />,
  );

  await screen.findByTestId("approval-row-ap-1");
  // Loaded from the agent-scoped endpoint.
  expect(mockFetchWithRefresh).toHaveBeenCalledWith("/api/admin/agents/approvals?agentId=agent-9");
  // Human-readable capture, no secrets.
  expect(screen.getByTestId("approval-summary-ap-1")).toHaveTextContent("Contact · Name=Jane Doe, Email=jane@acme.com");
  // Detail mode: the "proposed by agent" line is suppressed (agent is the subject).
  expect(screen.queryByText(/Proposed by agent/i)).toBeNull();
  // Parent gets the live count for a badge.
  await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(1));
});

it("approve POSTs the decision, drops the row, and reports the new count", async () => {
  route(APPROVALS);
  const onCount = jest.fn();
  render(<ApprovalList endpoint="/api/admin/agents/approvals?agentId=agent-9" testIdPrefix="agent-approvals" onCountChange={onCount} />);

  const approve = await screen.findByTestId("approve-ap-1");
  fireEvent.click(approve);

  await waitFor(() => expect(screen.queryByTestId("approval-row-ap-1")).toBeNull());
  expect(mockFetchWithRefresh).toHaveBeenCalledWith(
    "/api/admin/agents/approvals/ap-1",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "approve" }) }),
  );
  expect(onCount).toHaveBeenLastCalledWith(0);
});

it("renders the custom empty state when nothing is pending", async () => {
  route([]);
  render(<ApprovalList endpoint="/api/admin/agents/approvals?agentId=agent-9" testIdPrefix="agent-approvals" emptyText="This agent has nothing awaiting approval." />);
  expect(await screen.findByTestId("agent-approvals-empty")).toHaveTextContent("nothing awaiting approval");
});
