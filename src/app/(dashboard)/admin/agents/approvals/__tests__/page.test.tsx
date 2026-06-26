/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * UI tests for the agent write-approval queue (/admin/agents/approvals).
 * Asserts: a pending write renders with a human-readable summary; approve and
 * reject POST the right decision and drop the row in place; the empty state
 * shows when nothing is pending; a failed load surfaces an error.
 * fetchWithRefresh is mocked + routed by URL/method so list vs decide calls are
 * asserted independently.
 */

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AgentApprovalsPage from "@/app/(dashboard)/admin/agents/approvals/page";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkRes(body: unknown, opts: { ok?: boolean; status?: number } = {}): any {
  return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body };
}
const APPROVALS = [
  {
    id: "ap-1", agentId: "agent-1", ownerUserId: "owner-1", tool: "create_external_record",
    params: { objectType: "contact", fields: { Name: "Jane Doe", Email: "jane@acme.com" }, connector: "salesforce" },
    capability: "*", decisionSeq: 7, createdAt: "t",
  },
];
function route(approvals: unknown[]) {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (url === "/api/admin/agents/approvals" && !opts) return Promise.resolve(mkRes({ approvals }));
    if (url.startsWith("/api/admin/agents/approvals/") && opts?.method === "POST") return Promise.resolve(mkRes({ ok: true, status: "executed" }));
    return Promise.resolve(mkRes({}));
  });
}

beforeEach(() => mockFetchWithRefresh.mockReset());

it("renders a pending write with a human-readable summary", async () => {
  route(APPROVALS);
  render(<AgentApprovalsPage />);
  expect(await screen.findByTestId("approval-row-ap-1")).toBeInTheDocument();
  expect(screen.getByTestId("approval-summary-ap-1")).toHaveTextContent("Contact · Name=Jane Doe, Email=jane@acme.com");
});

it("approve POSTs {action:'approve'} and drops the row", async () => {
  route(APPROVALS);
  render(<AgentApprovalsPage />);
  await screen.findByTestId("approval-row-ap-1");
  fireEvent.click(screen.getByTestId("approve-ap-1"));
  await waitFor(() => expect(screen.queryByTestId("approval-row-ap-1")).not.toBeInTheDocument());
  const post = mockFetchWithRefresh.mock.calls.find((c) => String(c[0]).endsWith("/approvals/ap-1") && c[1]?.method === "POST");
  expect(JSON.parse(String(post![1].body))).toEqual({ action: "approve" });
});

it("reject POSTs {action:'reject'} and drops the row", async () => {
  route(APPROVALS);
  render(<AgentApprovalsPage />);
  await screen.findByTestId("approval-row-ap-1");
  fireEvent.click(screen.getByTestId("reject-ap-1"));
  await waitFor(() => expect(screen.queryByTestId("approval-row-ap-1")).not.toBeInTheDocument());
  const post = mockFetchWithRefresh.mock.calls.find((c) => String(c[0]).endsWith("/approvals/ap-1") && c[1]?.method === "POST");
  expect(JSON.parse(String(post![1].body))).toEqual({ action: "reject" });
});

it("shows the empty state when nothing is pending", async () => {
  route([]);
  render(<AgentApprovalsPage />);
  expect(await screen.findByTestId("approvals-empty")).toBeInTheDocument();
});

it("surfaces an error when the load fails", async () => {
  mockFetchWithRefresh.mockResolvedValue(mkRes({}, { ok: false, status: 500 }));
  render(<AgentApprovalsPage />);
  expect(await screen.findByTestId("approvals-error")).toBeInTheDocument();
});
