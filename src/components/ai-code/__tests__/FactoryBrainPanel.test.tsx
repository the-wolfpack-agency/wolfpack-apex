/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import FactoryBrainPanel from "@/components/ai-code/FactoryBrainPanel";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({ fetchWithRefresh: (...a: unknown[]) => mockFetch(...a) }));

beforeEach(() => jest.clearAllMocks());

const summary = (over = {}) => ({
  windowDays: 30,
  memory: { reuse: 42, failures: 7, exemplars: 5 },
  improving: { firstPassReadyRate: 0.8, acceptanceRate: 0.6, trend: "up", runs: 12 },
  precision: { wrongRate: 0.2, reviewed: 10 },
  repair: { resolveRate: 0.4, runs: 10 },
  grades: { cells: 3 },
  corrections: { editRate: 0.3, merged: 10 },
  ...over,
});

it("renders the headline learning signals", async () => {
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ summary: summary() }) });
  render(<FactoryBrainPanel />);
  await waitFor(() => expect(screen.getByTestId("factory-brain-panel")).toBeInTheDocument());
  expect(screen.getByText("42")).toBeInTheDocument();        // reuse corpus
  expect(screen.getByText("80%")).toBeInTheDocument();       // first-pass ready
  expect(screen.getByText("20%")).toBeInTheDocument();       // gate false-positive
  expect(screen.getByTestId("brain-trend")).toHaveTextContent("↑"); // improving trend
  expect(screen.getAllByTestId("brain-tile").length).toBe(8);
});

it("shows n/a honestly on a cold start (no data) instead of a fake 100%", async () => {
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ summary: summary({
    improving: { firstPassReadyRate: null, acceptanceRate: null, trend: "n/a", runs: 0 },
    precision: { wrongRate: null, reviewed: 0 },
    repair: { resolveRate: null, runs: 0 },
    corrections: { editRate: null, merged: 0 },
  }) }) });
  render(<FactoryBrainPanel />);
  await waitFor(() => expect(screen.getByTestId("factory-brain-panel")).toBeInTheDocument());
  expect(screen.getAllByText("n/a").length).toBeGreaterThanOrEqual(4);
});

it("renders nothing until the summary loads (no broken widget)", async () => {
  mockFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
  const { container } = render(<FactoryBrainPanel />);
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  expect(container.querySelector('[data-testid="factory-brain-panel"]')).toBeNull();
});
