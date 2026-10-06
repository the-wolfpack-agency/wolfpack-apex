/** @jest-environment jsdom */
import "@testing-library/jest-dom";

/**
 * UI test for the public Forcefield client dashboard. Proves the token flow:
 * paste + connect POSTs the token in the x-forcefield-token header and renders
 * the client's scoped numbers; a 401 shows a clear "not recognized" message and
 * NO stats; a saved token auto-connects on mount. fetch + localStorage are the
 * only externals and are controlled here.
 */
const mockFetch = jest.fn();
beforeAll(() => {
  (global as { fetch: unknown }).fetch = (...a: unknown[]) => mockFetch(...a);
});

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import ForcefieldDashboardPage from "../page";

const STATS = {
  ok: true,
  tenant: { id: "t1", name: "Before U Trade", siteLabel: "beforeutrade" },
  stats: {
    rangeDays: 30, agentsDetected: 1234, welcomed: 200, trapped: 12, probed: 300,
    payloads: 45, hostile: 357, sitesProtected: 1, attacks: [{ attack: "sql_injection", count: 9 }],
  },
};

const okResponse = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
});

it("renders the connect form when no token is stored", async () => {
  render(<ForcefieldDashboardPage />);
  expect(await screen.findByTestId("ff-token-form")).toBeInTheDocument();
  expect(screen.getByTestId("ff-connect")).toBeDisabled(); // empty input gates submit
  expect(screen.queryByTestId("ff-stats")).not.toBeInTheDocument();
});

it("connects with a pasted token and renders the client's scoped numbers", async () => {
  mockFetch.mockResolvedValueOnce(okResponse(STATS));
  render(<ForcefieldDashboardPage />);
  await screen.findByTestId("ff-token-form");
  fireEvent.change(screen.getByTestId("ff-token-input"), { target: { value: "ff_realtoken" } });
  fireEvent.click(screen.getByTestId("ff-connect"));

  expect(await screen.findByTestId("ff-stats")).toBeInTheDocument();
  // the token went in the header, not the URL
  const [url, init] = mockFetch.mock.calls[0];
  expect(url).toBe("/api/forcefield/my-stats");
  expect((init as RequestInit).headers).toMatchObject({ "x-forcefield-token": "ff_realtoken" });
  // the scoped numbers render
  expect(screen.getByTestId("ff-m-detected")).toHaveTextContent("1,234");
  expect(screen.getByTestId("ff-m-hostile")).toHaveTextContent("357");
  expect(screen.getByTestId("ff-attack-sql_injection")).toHaveTextContent("SQL injection");
  // token persisted for a returning visit
  expect(window.localStorage.getItem("ff_dashboard_token")).toBe("ff_realtoken");
});

it("shows a clear not-recognized message on 401 and renders NO stats", async () => {
  mockFetch.mockResolvedValueOnce(okResponse({ ok: false, error: "unauthorized" }, 401));
  render(<ForcefieldDashboardPage />);
  await screen.findByTestId("ff-token-form");
  fireEvent.change(screen.getByTestId("ff-token-input"), { target: { value: "ff_bogus" } });
  fireEvent.click(screen.getByTestId("ff-connect"));

  expect(await screen.findByTestId("ff-error")).toHaveTextContent(/not recognized/i);
  expect(screen.queryByTestId("ff-stats")).not.toBeInTheDocument();
  // a rejected token is not persisted
  expect(window.localStorage.getItem("ff_dashboard_token")).toBeNull();
});

it("auto-connects when a token is already saved in the browser", async () => {
  window.localStorage.setItem("ff_dashboard_token", "ff_saved");
  mockFetch.mockResolvedValueOnce(okResponse(STATS));
  render(<ForcefieldDashboardPage />);
  await waitFor(() => expect(screen.getByTestId("ff-stats")).toBeInTheDocument());
  expect((mockFetch.mock.calls[0][1] as RequestInit).headers).toMatchObject({
    "x-forcefield-token": "ff_saved",
  });
});
