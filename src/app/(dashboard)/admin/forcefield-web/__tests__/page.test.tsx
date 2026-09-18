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

import ForcefieldWebPage from "../page";

function resp(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}
const REPORT = { inspected: 20, welcomed: 8, allowed: 9, reported: 2, blocked: 1, decoyTrips: 1, sampleCapped: false };

beforeEach(() => { jest.clearAllMocks(); user = { role: "cto" }; mockFetch.mockResolvedValue(resp(200, { report: REPORT })); });

test("redirects an unauthenticated user", () => {
  user = null;
  render(<ForcefieldWebPage />);
  expect(mockPush).toHaveBeenCalledWith("/login?next=/admin/forcefield-web");
  expect(screen.queryByTestId("forcefield-web")).not.toBeInTheDocument();
});

test("renders the protection numbers from the report", async () => {
  render(<ForcefieldWebPage />);
  await waitFor(() => expect(screen.getByTestId("ffw-metrics")).toBeInTheDocument());
  expect(screen.getByTestId("ffw-inspected")).toHaveTextContent("20");
  expect(screen.getByTestId("ffw-welcomed")).toHaveTextContent("8");
  expect(screen.getByTestId("ffw-trips")).toHaveTextContent("1");
  expect(screen.getByTestId("ffw-blocked")).toHaveTextContent("1");
});

test("shows an honest empty state before any traffic (no fabricated numbers)", async () => {
  mockFetch.mockResolvedValue(resp(200, { report: { ...REPORT, inspected: 0, welcomed: 0, allowed: 0, reported: 0, blocked: 0, decoyTrips: 0 } }));
  render(<ForcefieldWebPage />);
  await waitFor(() => expect(screen.getByTestId("ffw-empty")).toBeInTheDocument());
  expect(screen.queryByTestId("ffw-metrics")).not.toBeInTheDocument();
});

test("shows the 'at least' lower-bound wording only when capped", async () => {
  mockFetch.mockResolvedValue(resp(200, { report: { ...REPORT, sampleCapped: true } }));
  render(<ForcefieldWebPage />);
  await waitFor(() => expect(screen.getByTestId("ffw-capped")).toBeInTheDocument());
  expect(screen.getByTestId("ffw-inspected")).toHaveTextContent("at least 20");
});

test("shows an error state if the report cannot load", async () => {
  mockFetch.mockResolvedValue(resp(500, {}));
  render(<ForcefieldWebPage />);
  await waitFor(() => expect(screen.getByTestId("ffw-error")).toBeInTheDocument());
});
