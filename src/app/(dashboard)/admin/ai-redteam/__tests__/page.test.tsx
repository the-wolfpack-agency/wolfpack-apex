/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * UI tests for the AI Red-Team assurance page (/admin/ai-redteam). Asserts the
 * run history renders, the empty state, an error on a non-ok GET, and that "Run
 * red-team now" POSTs and renders the resulting report (pass rate + category
 * breakdown, and a vuln callout when an attack gets through). fetchWithRefresh is
 * mocked and routed by method.
 */

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import AiRedteamPage from "../page";

const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body });
const run = (over: Record<string, unknown> = {}) => ({ id: "art_1", attacksRun: 8, blocked: 8, vulns: 0, passRate: 1, risk: "low", source: "cron", createdAt: "2026-06-30", ...over });

function routeByMethod(getBody: unknown, postBody?: unknown) {
  return (_url: string, opts?: { method?: string }) =>
    Promise.resolve(opts?.method === "POST" ? json(postBody) : json(getBody));
}

beforeEach(() => jest.resetAllMocks());

test("renders the run history from the API", async () => {
  mockFetch.mockImplementation(routeByMethod({ runs: [run(), run({ id: "art_2", vulns: 1, passRate: 0.875, risk: "critical" })] }));
  render(<AiRedteamPage />);
  expect(await screen.findByTestId("ai-redteam-summary")).toBeInTheDocument();
  await waitFor(() => expect(screen.getAllByTestId("ai-redteam-row")).toHaveLength(2));
  expect(screen.getByText("regression")).toBeInTheDocument(); // the vuln run
});

test("empty state when there are no runs", async () => {
  mockFetch.mockImplementation(routeByMethod({ runs: [] }));
  render(<AiRedteamPage />);
  expect(await screen.findByTestId("ai-redteam-empty")).toBeInTheDocument();
});

test("error on a non-ok GET", async () => {
  mockFetch.mockResolvedValue(json({}, false, 403));
  render(<AiRedteamPage />);
  expect(await screen.findByTestId("ai-redteam-error")).toBeInTheDocument();
});

test("'Run red-team now' POSTs and renders the report with the category breakdown", async () => {
  mockFetch.mockImplementation(
    routeByMethod(
      { runs: [] },
      { report: { attacksRun: 8, blocked: 8, vulns: [], passRate: 1, byCategory: { LLM06_info_disclosure: { run: 2, blocked: 2 } } } },
    ),
  );
  render(<AiRedteamPage />);
  await screen.findByTestId("ai-redteam-empty");

  fireEvent.click(screen.getByTestId("ai-redteam-run"));
  await waitFor(() => expect(screen.getByTestId("ai-redteam-category")).toBeInTheDocument());
  expect(screen.getByText("Info disclosure")).toBeInTheDocument();
  // POST was issued.
  expect(mockFetch).toHaveBeenCalledWith("/api/admin/ai-redteam/run", expect.objectContaining({ method: "POST" }));
});

test("a run with vulns shows the regression callout", async () => {
  mockFetch.mockImplementation(
    routeByMethod(
      { runs: [] },
      { report: { attacksRun: 8, blocked: 7, vulns: [{ attackId: "exfil-secret-via-mail", category: "LLM06_info_disclosure", technique: "t", outcome: "allow", ruleId: "R" }], passRate: 0.875, byCategory: { LLM06_info_disclosure: { run: 2, blocked: 1 } } } },
    ),
  );
  render(<AiRedteamPage />);
  await screen.findByTestId("ai-redteam-empty");
  fireEvent.click(screen.getByTestId("ai-redteam-run"));
  await waitFor(() => expect(screen.getByTestId("ai-redteam-vulns")).toBeInTheDocument());
  expect(screen.getByText(/exfil-secret-via-mail/)).toBeInTheDocument();
});
