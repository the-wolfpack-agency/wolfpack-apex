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

// --- Live repo-scan additions ---------------------------------------------

const remediation = {
  kind: "ai_sdk",
  provider: "openai",
  summary: "Ungoverned openai SDK call — wrap it in a gate-authorized client.",
  steps: ["Locate the openai SDK call.", "Authorize via /api/gate/authorize."],
  snippet: 'fetchWithRefresh("/api/gate/authorize", ...)',
  priority: "later",
};

test("scanning a repo POSTs the URL, then renders surfaces + a remediation expander", async () => {
  // Initial inventory load (empty), then the repo-scan POST, then the reload.
  mockFetchWithRefresh
    .mockResolvedValueOnce(
      jsonResponse({ surfaces: [], summary: { total: 0, ungoverned: 0, byKind: {}, byProvider: {}, byRisk: {} } }),
    )
    .mockResolvedValueOnce(jsonResponse({ result: { remediations: [remediation] } }))
    .mockResolvedValue(
      jsonResponse({
        surfaces: [surface()],
        summary: { total: 1, ungoverned: 1, byKind: { ai_sdk: 1 }, byProvider: { openai: 1 }, byRisk: { medium: 1 } },
      }),
    );

  render(<AiSurfacesPage />);
  await screen.findByTestId("ai-surfaces-empty");

  fireEvent.change(screen.getByTestId("repo-scan-url"), {
    target: { value: "https://github.com/openai/openai-node" },
  });
  fireEvent.click(screen.getByTestId("repo-scan-button"));

  // The POST went to the repo-scan route with the URL in the body.
  await waitFor(() =>
    expect(mockFetchWithRefresh).toHaveBeenCalledWith(
      "/api/admin/ai-surfaces/repo-scan",
      expect.objectContaining({ method: "POST" }),
    ),
  );
  const postCall = mockFetchWithRefresh.mock.calls.find((c) => c[0] === "/api/admin/ai-surfaces/repo-scan");
  expect(JSON.parse((postCall![1] as { body: string }).body)).toEqual({
    url: "https://github.com/openai/openai-node",
  });

  // The reloaded inventory renders the discovered surface + the fix toggle.
  const toggle = await screen.findByTestId("remediation-toggle");
  fireEvent.click(toggle);
  expect(await screen.findByTestId("remediation-row")).toBeInTheDocument();
  expect(screen.getByText(/wrap it in a gate-authorized client/i)).toBeInTheDocument();
});

test("the scan button is disabled while a scan is in flight (loading state)", async () => {
  mockFetchWithRefresh.mockResolvedValueOnce(
    jsonResponse({ surfaces: [], summary: { total: 0, ungoverned: 0, byKind: {}, byProvider: {}, byRisk: {} } }),
  );
  // A scan POST that never resolves — the button stays in the scanning state.
  mockFetchWithRefresh.mockImplementationOnce(() => new Promise(() => {}));

  render(<AiSurfacesPage />);
  await screen.findByTestId("ai-surfaces-empty");
  fireEvent.change(screen.getByTestId("repo-scan-url"), {
    target: { value: "https://github.com/o/r" },
  });
  fireEvent.click(screen.getByTestId("repo-scan-button"));
  await waitFor(() => expect(screen.getByTestId("repo-scan-button")).toBeDisabled());
  expect(screen.getByTestId("repo-scan-button")).toHaveTextContent(/scanning/i);
});

test("a failed scan surfaces the error message", async () => {
  mockFetchWithRefresh
    .mockResolvedValueOnce(
      jsonResponse({ surfaces: [], summary: { total: 0, ungoverned: 0, byKind: {}, byProvider: {}, byRisk: {} } }),
    )
    .mockResolvedValueOnce(jsonResponse({ error: "only github.com repositories are supported" }, false, 400));

  render(<AiSurfacesPage />);
  await screen.findByTestId("ai-surfaces-empty");
  fireEvent.change(screen.getByTestId("repo-scan-url"), {
    target: { value: "https://gitlab.com/o/r" },
  });
  fireEvent.click(screen.getByTestId("repo-scan-button"));

  expect(await screen.findByTestId("repo-scan-error")).toHaveTextContent(/only github\.com/i);
});
