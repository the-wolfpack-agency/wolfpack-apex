/** @jest-environment jsdom */
import "@testing-library/jest-dom";

/**
 * UI test for the operator signup-review page. Proves it loads pending requests,
 * approve POSTs and reveals the token + quick-start once, and reject POSTs and
 * refreshes the list. Auth + fetch are mocked.
 */
const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  getInstinctUser: () => ({ role: "cto" }),
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import ForcefieldSignupsPage from "../page";

const REQ = { id: "r1", name: "Dana", email: "dana@acme.com", siteUrl: "acme.com", note: "please", status: "pending", createdAt: "2026-10-06T00:00:00Z" };
const APPROVED = {
  ok: true,
  tenant: { id: "t-9", name: "Dana", siteLabel: "acme.com", status: "active", createdAt: "2026-10-06T00:00:00Z" },
  token: "ff_minted123",
  quickstart: { token: "ff_minted123", cloudflareEnv: { SITE_ANALYTICS_INGEST_TOKEN: "ff_minted123" }, nextEnv: {}, nextSnippet: "@ogiam/forcefield/next" },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ requests: [REQ] }) }); // initial load
});

it("lists pending requests", async () => {
  render(<ForcefieldSignupsPage />);
  await waitFor(() => expect(screen.getByTestId("s-list")).toBeInTheDocument());
  expect(screen.getByTestId("s-row-r1")).toHaveTextContent("dana@acme.com");
  expect(screen.getByTestId("s-row-r1")).toHaveTextContent("acme.com");
});

it("approve reveals the token + quick-start once", async () => {
  render(<ForcefieldSignupsPage />);
  await screen.findByTestId("s-approve-r1");
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => APPROVED }); // POST approve
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ requests: [] }) }); // reload
  fireEvent.click(screen.getByTestId("s-approve-r1"));

  const panel = await screen.findByTestId("s-approved");
  expect(panel).toHaveTextContent("Dana is onboarded");
  expect(screen.getByTestId("s-token")).toHaveTextContent("ff_minted123");
  expect(panel).toHaveTextContent("SITE_ANALYTICS_INGEST_TOKEN=ff_minted123");
  // the POST carried the approve action
  const approveCall = mockFetch.mock.calls.find((c) => (c[1] as RequestInit)?.body?.toString().includes("approve"));
  expect(approveCall).toBeTruthy();
});

it("AI summary button POSTs to the risk-summary endpoint and shows the summary inline", async () => {
  render(<ForcefieldSignupsPage />);
  await screen.findByTestId("s-summarize-r1");
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, summary: "Looks legitimate.", model: "gpt-4o-mini", degraded: false }) });
  fireEvent.click(screen.getByTestId("s-summarize-r1"));

  await waitFor(() => expect(screen.getByTestId("s-summary-r1")).toHaveTextContent("Looks legitimate."));
  const call = mockFetch.mock.calls.find((c) => String(c[0]).includes("/risk-summary"));
  expect(call).toBeTruthy();
  expect((call![1] as RequestInit).body).toContain("r1");
});

it("AI summary shows an inline note when unavailable (never blocks the review)", async () => {
  render(<ForcefieldSignupsPage />);
  await screen.findByTestId("s-summarize-r1");
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: false, reason: "no_provider" }) });
  fireEvent.click(screen.getByTestId("s-summarize-r1"));
  await waitFor(() => expect(screen.getByTestId("s-summary-r1")).toHaveTextContent(/not configured/i));
  // the row is still actionable
  expect(screen.getByTestId("s-approve-r1")).toBeInTheDocument();
});

it("reject POSTs the reject action and shows no token panel", async () => {
  render(<ForcefieldSignupsPage />);
  await screen.findByTestId("s-reject-r1");
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) }); // POST reject
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ requests: [] }) }); // reload
  fireEvent.click(screen.getByTestId("s-reject-r1"));

  await waitFor(() => {
    const rejectCall = mockFetch.mock.calls.find((c) => (c[1] as RequestInit)?.body?.toString().includes("reject"));
    expect(rejectCall).toBeTruthy();
  });
  expect(screen.queryByTestId("s-approved")).not.toBeInTheDocument();
});
