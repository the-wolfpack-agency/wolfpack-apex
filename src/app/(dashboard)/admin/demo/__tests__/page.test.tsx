/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * UI tests for the Demo Reset page (/admin/demo). Asserts the pre-run empty
 * state + beat links, that "Reset demo data" POSTs and renders the per-beat
 * summary (surfaces / decisions / would-block / red-team / enforcement rows),
 * and the error state on a failed seed. fetchWithRefresh is mocked.
 */

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import DemoResetPage from "../page";

const result = {
  target: "demo/acme-agent-platform",
  surfaces: { found: 4, written: 4, ungoverned: 4 },
  decisions: { recorded: 5, flagged: 3, wouldBlock: 2 },
  enforcement: [
    { capability: "finance.payment", mode: "enforce" },
    { capability: "data.export", mode: "monitor" },
  ],
  redteam: { attacks: 20, blocked: 20, vulns: 0, passRate: 1 },
  compliance: [{ framework: "SOC2", coverage: 0.8, gap: 1 }],
};

beforeEach(() => jest.resetAllMocks());

test("renders the pre-run empty state with beat links", () => {
  render(<DemoResetPage />);
  expect(screen.getByTestId("demo-reset-empty")).toBeInTheDocument();
  // Deep links into each beat so the operator can walk the demo.
  expect(screen.getByText("Discover")).toBeInTheDocument();
  expect(screen.getByText("Comply")).toBeInTheDocument();
});

test("Reset POSTs and renders the per-beat summary + enforcement rows", async () => {
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ result }) });
  render(<DemoResetPage />);

  fireEvent.click(screen.getByTestId("demo-reset-run"));

  await waitFor(() => expect(screen.getByTestId("demo-reset-summary")).toBeInTheDocument());
  // POSTed to the seed endpoint.
  expect(mockFetch).toHaveBeenCalledWith("/api/admin/ogiam/demo-reset", expect.objectContaining({ method: "POST" }));
  // The seeded enforcement postures render.
  expect(screen.getAllByTestId("demo-reset-policy-row")).toHaveLength(2);
  expect(screen.getByText("finance.payment")).toBeInTheDocument();
});

test("error state when the seed fails", async () => {
  mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
  render(<DemoResetPage />);
  fireEvent.click(screen.getByTestId("demo-reset-run"));
  expect(await screen.findByTestId("demo-reset-error")).toBeInTheDocument();
});
