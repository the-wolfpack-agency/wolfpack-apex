/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * UI tests for the Compliance Evidence page (/admin/compliance). Asserts the
 * history renders (empty + rows), an error on a non-ok GET, and that "Generate
 * report" POSTs with the selected framework and renders the coverage summary +
 * per-control table (including a gap row). fetchWithRefresh is mocked + routed.
 */

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import CompliancePage from "../page";

const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body });

const report = {
  framework: "EU_AI_ACT",
  controls: [
    { id: "EUAIACT-ART12", name: "Record-keeping", ogiamControl: "Tamper-evident ledger", rationale: "r", status: "gap", evidence: "audit chain unverified" },
    { id: "EUAIACT-ART14", name: "Human oversight", ogiamControl: "Gate escalation", rationale: "r", status: "covered", evidence: "ok" },
  ],
  covered: 3,
  partial: 0,
  gap: 1,
  coverage: 0.75,
};

function route(getBody: unknown) {
  return (_url: string, opts?: { method?: string; body?: string }) =>
    Promise.resolve(opts?.method === "POST" ? json({ report, _sent: opts.body }) : json(getBody));
}

beforeEach(() => jest.resetAllMocks());

test("renders report history rows", async () => {
  mockFetch.mockImplementation(route({ reports: [{ id: "cmp_1", framework: "SOC2", coverage: 1, covered: 4, partial: 0, gap: 0, createdAt: "2026-06-30" }] }));
  render(<CompliancePage />);
  await waitFor(() => expect(screen.getByTestId("compliance-history-row")).toBeInTheDocument());
  expect(screen.getByText("SOC2")).toBeInTheDocument();
});

test("empty history state", async () => {
  mockFetch.mockImplementation(route({ reports: [] }));
  render(<CompliancePage />);
  expect(await screen.findByTestId("compliance-empty")).toBeInTheDocument();
});

test("error on a non-ok GET", async () => {
  mockFetch.mockResolvedValue(json({}, false, 403));
  render(<CompliancePage />);
  expect(await screen.findByTestId("compliance-error")).toBeInTheDocument();
});

test("download signed evidence: button present on a history row, clicking calls the export endpoint via fetchWithRefresh", async () => {
  // jsdom lacks blob/object-URL + anchor.click download plumbing; stub them.
  const createObjectURL = jest.fn(() => "blob:evidence");
  const revokeObjectURL = jest.fn();
  Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true });
  jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

  mockFetch.mockImplementation((url: string) =>
    typeof url === "string" && url.includes("/export")
      ? Promise.resolve({ ok: true, status: 200, blob: async () => new Blob(["{}"], { type: "application/json" }) })
      : route({ reports: [{ id: "cmp_42", framework: "SOC2", coverage: 1, covered: 4, partial: 0, gap: 0, createdAt: "2026-06-30" }] })(url),
  );

  render(<CompliancePage />);
  const btn = await screen.findByTestId("compliance-export");
  expect(btn).toBeInTheDocument();

  fireEvent.click(btn);

  await waitFor(() =>
    expect(mockFetch.mock.calls.some((c) => typeof c[0] === "string" && c[0].includes("/api/admin/compliance/report/export?id=cmp_42"))).toBe(true),
  );
  await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
});

test("generate POSTs the selected framework and renders the coverage + controls (incl. a gap)", async () => {
  mockFetch.mockImplementation(route({ reports: [] }));
  render(<CompliancePage />);
  await screen.findByTestId("compliance-empty");

  fireEvent.change(screen.getByLabelText("Framework"), { target: { value: "EU_AI_ACT" } });
  fireEvent.click(screen.getByTestId("compliance-generate"));

  await waitFor(() => expect(screen.getByTestId("compliance-summary")).toBeInTheDocument());
  expect(screen.getAllByTestId("compliance-control-row")).toHaveLength(2);
  // The POST carried the chosen framework.
  const postCall = mockFetch.mock.calls.find((c) => c[1]?.method === "POST");
  expect(postCall?.[1].body).toContain("EU_AI_ACT");
  // The gap control shows.
  expect(screen.getByText(/EUAIACT-ART12/)).toBeInTheDocument();
});
