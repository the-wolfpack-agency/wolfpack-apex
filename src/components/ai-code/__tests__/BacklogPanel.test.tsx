/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import BacklogPanel from "@/components/ai-code/BacklogPanel";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({ fetchWithRefresh: (...a: unknown[]) => mockFetch(...a) }));

beforeEach(() => jest.clearAllMocks());

it("renders the empty state when there are no outcomes yet", async () => {
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ backlog: { total: 0, autonomous: 0, escalated: 0, autonomyRate: 0, byClass: [], recent: [] } }) });
  render(<BacklogPanel />);
  await waitFor(() => expect(screen.getByText(/No terminal ci-fix outcomes recorded yet/i)).toBeInTheDocument());
});

it("renders the autonomy rate and the ranked backlog", async () => {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ backlog: {
      total: 4, autonomous: 3, escalated: 1, autonomyRate: 0.75,
      byClass: [{ class: "governance", count: 1 }],
      recent: [{ repo: "o/r", ref: "feat-dep", class: "governance", reason: "dependency audit", createdAt: "2026-09-30T00:00:00Z" }],
    } }),
  });
  render(<BacklogPanel />);
  await waitFor(() => expect(screen.getByText("75%")).toBeInTheDocument());
  expect(screen.getByText("Governance gate")).toBeInTheDocument();
  expect(screen.getByText("feat-dep")).toBeInTheDocument();
  expect(screen.getByText(/dependency audit/i)).toBeInTheDocument();
});

it("shows the empty state when the fetch fails (never blank/broken)", async () => {
  mockFetch.mockRejectedValue(new Error("network"));
  render(<BacklogPanel />);
  await waitFor(() => expect(screen.getByText(/No terminal ci-fix outcomes recorded yet/i)).toBeInTheDocument());
});
