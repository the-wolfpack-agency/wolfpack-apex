/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
const mockFetch = jest.fn();
let user: unknown = { role: "cto" };
jest.mock("@/lib/client-auth", () => ({
  getInstinctUser: () => user,
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "content-type": "application/json" }),
}));

import EffectivenessPage from "../page";

function resp(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}
const REPORT = {
  sampleCapped: false,
  secureAgent: { changesGoverned: 12, blocked: 3, sentToHuman: 2, allowed: 7, risksCaught: 9 },
  forcefield: { decoysActive: 5, trips: 2, agentsContained: 1 },
  governance: { actionsGoverned: 40, denied: 4, escalated: 3, transformed: 1, allowed: 32, wouldBlock: 7, agentsActive: 5 },
  cost: { monthToDateUsd: 18.4, measured: true },
  enforcement: { capabilityDenied: 5, connectorScopeDenied: 2, ceilingHits: 3, conductDenied: 1, total: 11 },
};

beforeEach(() => { jest.clearAllMocks(); user = { role: "cto" }; mockFetch.mockResolvedValue(resp(200, { report: REPORT })); });

test("redirects an unauthenticated user", () => {
  user = null;
  render(<EffectivenessPage />);
  expect(mockPush).toHaveBeenCalledWith("/login?next=/admin/effectiveness");
  expect(screen.queryByTestId("effectiveness")).not.toBeInTheDocument();
});

test("renders both products' numbers from the report", async () => {
  render(<EffectivenessPage />);
  await waitFor(() => expect(screen.getByTestId("eff-secure-agent")).toBeInTheDocument());
  expect(screen.getByTestId("eff-governed")).toHaveTextContent("12");
  expect(screen.getByTestId("eff-blocked")).toHaveTextContent("3");
  expect(screen.getByTestId("eff-risks")).toHaveTextContent("9");
  expect(screen.getByTestId("eff-decoys")).toHaveTextContent("5");
  expect(screen.getByTestId("eff-contained")).toHaveTextContent("1");
  // Per-action governance + COGS render from the same report.
  expect(screen.getByTestId("eff-actions-governed")).toHaveTextContent("40");
  expect(screen.getByTestId("eff-would-block")).toHaveTextContent("7");
  expect(screen.getByTestId("eff-agents-active")).toHaveTextContent("5");
  expect(screen.getByTestId("eff-cost-mtd")).toHaveTextContent("$18.40");
  // Downstream enforcement tiles render from the same report.
  expect(screen.getByTestId("eff-cap-denied")).toHaveTextContent("5");
  expect(screen.getByTestId("eff-scope-denied")).toHaveTextContent("2");
  expect(screen.getByTestId("eff-ceiling-hits")).toHaveTextContent("3");
  expect(screen.getByTestId("eff-conduct-denied")).toHaveTextContent("1");
  expect(screen.queryByTestId("eff-capped")).not.toBeInTheDocument();
});

test("shows 'Not measured' for cost when the cost view could not be read", async () => {
  mockFetch.mockResolvedValue(resp(200, { report: { ...REPORT, cost: { monthToDateUsd: 0, measured: false } } }));
  render(<EffectivenessPage />);
  await waitFor(() => expect(screen.getByTestId("eff-cost-mtd")).toBeInTheDocument());
  expect(screen.getByTestId("eff-cost-mtd")).toHaveTextContent("Not measured");
});

test("shows the 'at least' lower-bound wording only when the sample is capped", async () => {
  mockFetch.mockResolvedValue(resp(200, { report: { ...REPORT, sampleCapped: true } }));
  render(<EffectivenessPage />);
  await waitFor(() => expect(screen.getByTestId("eff-capped")).toBeInTheDocument());
  expect(screen.getByTestId("eff-governed")).toHaveTextContent("at least 12");
});

test("shows an error state if the report cannot load", async () => {
  mockFetch.mockResolvedValue(resp(500, {}));
  render(<EffectivenessPage />);
  await waitFor(() => expect(screen.getByTestId("eff-error")).toBeInTheDocument());
});
