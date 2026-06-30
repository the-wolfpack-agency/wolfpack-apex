/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * UI tests for the AI Surface Inventory page (/admin/ai-surfaces). Asserts the
 * inventory renders from a mocked fetch (summary + rows), the empty state shows
 * when nothing is discovered, an error surfaces on a non-ok response, and the
 * "ungoverned only" toggle re-fetches with the filter. fetchWithRefresh is
 * mocked and routed by URL.
 */

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetchWithRefresh(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import AiSurfacesPage from "../page";

const surface = (over: Record<string, unknown> = {}) => ({
  id: "ais_1",
  target: "repo",
  kind: "ai_sdk",
  provider: "openai",
  location: "src/x.ts:1",
  governed: false,
  risk: "medium",
  evidence: {},
  firstSeenAt: "",
  lastSeenAt: "",
  ...over,
});

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

beforeEach(() => {
  jest.resetAllMocks();
});

test("renders the summary + discovered surface rows from the API", async () => {
  mockFetchWithRefresh.mockResolvedValue(
    jsonResponse({
      surfaces: [surface(), surface({ id: "ais_2", kind: "api_key", provider: "anthropic", risk: "critical" })],
      summary: { total: 2, ungoverned: 2, byKind: { ai_sdk: 1, api_key: 1 }, byProvider: { openai: 1, anthropic: 1 }, byRisk: { medium: 1, critical: 1 } },
    }),
  );
  render(<AiSurfacesPage />);

  expect(await screen.findByTestId("ai-surfaces-summary")).toBeInTheDocument();
  // The headline labels render.
  expect(screen.getByText("Ungoverned")).toBeInTheDocument();
  // Two surface rows.
  await waitFor(() => expect(screen.getAllByTestId("ai-surface-row")).toHaveLength(2));
  expect(screen.getByText("AI key")).toBeInTheDocument(); // kind label mapping
});

test("shows the empty state when no surfaces are discovered", async () => {
  mockFetchWithRefresh.mockResolvedValue(
    jsonResponse({ surfaces: [], summary: { total: 0, ungoverned: 0, byKind: {}, byProvider: {}, byRisk: {} } }),
  );
  render(<AiSurfacesPage />);
  expect(await screen.findByTestId("ai-surfaces-empty")).toBeInTheDocument();
  expect(screen.queryByTestId("ai-surface-row")).not.toBeInTheDocument();
});

test("surfaces an error on a non-ok response", async () => {
  mockFetchWithRefresh.mockResolvedValue(jsonResponse({}, false, 403));
  render(<AiSurfacesPage />);
  expect(await screen.findByTestId("ai-surfaces-error")).toBeInTheDocument();
});

test("the 'ungoverned only' toggle re-fetches with the filter", async () => {
  mockFetchWithRefresh.mockResolvedValue(
    jsonResponse({ surfaces: [], summary: { total: 0, ungoverned: 0, byKind: {}, byProvider: {}, byRisk: {} } }),
  );
  render(<AiSurfacesPage />);
  await screen.findByTestId("ai-surfaces-empty");
  expect(mockFetchWithRefresh).toHaveBeenLastCalledWith("/api/admin/ai-surfaces");

  fireEvent.click(screen.getByRole("button", { name: /show ungoverned only/i }));
  await waitFor(() =>
    expect(mockFetchWithRefresh).toHaveBeenLastCalledWith("/api/admin/ai-surfaces?ungoverned=true"),
  );
});
