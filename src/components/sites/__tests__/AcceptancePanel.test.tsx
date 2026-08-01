/**
 * @jest-environment jsdom
 */

/**
 * The acceptance panel. The states worth pinning are the ones that decide
 * whether an operator trusts the build: an unchecked site must not look
 * reassuring, and a run that could not be performed must not look like a pass.
 */
import "@testing-library/jest-dom";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import AcceptancePanel from "../AcceptancePanel";

jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: jest.fn(),
  jsonHeaders: () => ({ "content-type": "application/json" }),
}));
import { fetchWithRefresh } from "@/lib/client-auth";

const CRITERIA = {
  prototypeUrl: "https://proto.test/",
  viewports: [{ width: 1512, height: 950 }],
  tolerancePx: 1.5,
  requiredRoutes: ["/", "/about"],
  requiredContent: ["Acme"],
  requireFontParity: true,
  maxLayoutDiffs: 0,
};

const json = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as unknown as Response;

beforeEach(() => jest.clearAllMocks());

it("shows the stored contract and the last verdict", async () => {
  (fetchWithRefresh as jest.Mock).mockResolvedValue(
    json({
      configured: true,
      criteria: CRITERIA,
      runs: [
        {
          id: "r1",
          deploy_id: "d1",
          deployed_url: "https://build.test",
          status: "passed",
          verdict: { accepted: true, summary: "Accepted: 3 check(s) passed", checks: [{ id: "routes", status: "passed", detail: "2 route(s) answered 2xx" }] },
          last_error: null,
          created_at: "2026-08-01T10:00:00Z",
        },
      ],
    }),
  );
  render(<AcceptancePanel siteId="p1" />);

  expect(await screen.findByTestId("acceptance-panel")).toBeInTheDocument();
  expect(screen.getByTestId("acceptance-prototype")).toHaveValue("https://proto.test/");
  expect(screen.getByTestId("acceptance-routes")).toHaveValue("/, /about");
  expect(screen.getByTestId("acceptance-latest-status")).toHaveTextContent("Accepted");
  expect(screen.getByTestId("acceptance-check-routes")).toHaveTextContent("2 route(s) answered 2xx");
});

it("says plainly that an unchecked build has not been verified", async () => {
  (fetchWithRefresh as jest.Mock).mockResolvedValue(json({ configured: false, criteria: CRITERIA, runs: [] }));
  render(<AcceptancePanel siteId="p1" />);

  // An empty history is the least reassuring state there is, and must read that way.
  expect(await screen.findByTestId("acceptance-no-runs")).toHaveTextContent(/has not been checked/i);
  expect(screen.getByTestId("acceptance-unconfigured")).toBeInTheDocument();
});

it("never renders a degraded run as a pass", async () => {
  (fetchWithRefresh as jest.Mock).mockResolvedValue(
    json({
      configured: true,
      criteria: CRITERIA,
      runs: [
        {
          id: "r1",
          deploy_id: "d1",
          deployed_url: "https://build.test",
          status: "degraded",
          verdict: {
            accepted: false,
            summary: "Not accepted: layout could not be checked, so this is not a pass",
            checks: [{ id: "layout", status: "unmeasured", detail: "the comparison could not run: browser_unavailable" }],
          },
          last_error: null,
          created_at: "2026-08-01T10:00:00Z",
        },
      ],
    }),
  );
  render(<AcceptancePanel siteId="p1" />);

  expect(await screen.findByTestId("acceptance-latest-status")).toHaveTextContent("Could not be checked");
  expect(screen.getByTestId("acceptance-latest-status")).not.toHaveTextContent(/^Accepted/);
  expect(screen.getByTestId("acceptance-check-layout")).toHaveTextContent("browser_unavailable");
});

it("saves the edited contract and confirms it", async () => {
  (fetchWithRefresh as jest.Mock)
    .mockResolvedValueOnce(json({ configured: true, criteria: CRITERIA, runs: [] }))
    .mockResolvedValueOnce(json({ criteria: { ...CRITERIA, tolerancePx: 3 }, completeness: 1 }));

  render(<AcceptancePanel siteId="p1" />);
  fireEvent.change(await screen.findByTestId("acceptance-tolerance"), { target: { value: "3" } });
  fireEvent.click(screen.getByTestId("acceptance-save"));

  await waitFor(() => expect(screen.getByTestId("acceptance-saved")).toBeInTheDocument());
  const put = (fetchWithRefresh as jest.Mock).mock.calls[1];
  expect(put[0]).toBe("/api/sites/p1/acceptance");
  expect(JSON.parse(put[1].body).criteria.tolerancePx).toBe(3);
});

it("surfaces the field the API refused, so the message can be acted on", async () => {
  (fetchWithRefresh as jest.Mock)
    .mockResolvedValueOnce(json({ configured: true, criteria: CRITERIA, runs: [] }))
    .mockResolvedValueOnce(json({ error: "tolerancePx must be 0 to 50", field: "tolerancePx" }, false, 400));

  render(<AcceptancePanel siteId="p1" />);
  fireEvent.click(await screen.findByTestId("acceptance-save"));

  await waitFor(() => expect(screen.getByTestId("acceptance-error")).toHaveTextContent("tolerancePx: tolerancePx must be 0 to 50"));
});

it("states a load failure rather than rendering an empty form that looks like no requirements", async () => {
  (fetchWithRefresh as jest.Mock).mockResolvedValue(json({}, false, 500));
  render(<AcceptancePanel siteId="p1" />);
  expect(await screen.findByTestId("acceptance-error")).toHaveTextContent(/could not load/i);
});
