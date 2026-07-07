/**
 * @jest-environment jsdom
 *
 * Invoices hub tests. The hub shows only the sub-page cards the caller may open:
 * the Vendor AP queue when they hold finance.invoices.view, plus one card per
 * SharePoint tracker the API returns for them. Access is decided by the API +
 * capabilities, never the page, so these assert the page honors both.
 */
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";

const mockFetch = jest.fn();
const mockPush = jest.fn();
jest.mock("@/lib/client-auth", () => ({ fetchWithRefresh: (...a: unknown[]) => mockFetch(...a) }));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));

import InvoicesHubPage from "../page";

function jsonRes(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 403, json: async () => body };
}

// Route each fetch by URL so the two parallel calls resolve independently.
function route(map: { trackers?: unknown; caps?: unknown; trackersOk?: boolean; capsOk?: boolean }) {
  mockFetch.mockImplementation((url: string) => {
    if (url === "/api/invoices") return Promise.resolve(jsonRes(map.trackers ?? { trackers: [] }, map.trackersOk ?? true));
    if (url === "/api/me/capabilities") return Promise.resolve(jsonRes(map.caps ?? { capabilities: [] }, map.capsOk ?? true));
    return Promise.resolve(jsonRes({}, false));
  });
}

beforeEach(() => jest.resetAllMocks());

test("shows a Vendor Invoices card when the user can view finance invoices", async () => {
  route({ caps: { capabilities: ["finance.invoices.view"] }, trackers: { trackers: [] } });
  render(<InvoicesHubPage />);
  await waitFor(() => expect(screen.getByText("Vendor Invoices")).toBeInTheDocument());
  expect(screen.getByText("Vendor Invoices").closest("a")).toHaveAttribute("href", "/invoices/vendor");
});

test("shows a card per SharePoint tracker the user is allowlisted for", async () => {
  route({ caps: { capabilities: [] }, trackers: { trackers: [{ id: "pcna", company: "PCNA" }] } });
  render(<InvoicesHubPage />);
  await waitFor(() => expect(screen.getByText("PCNA")).toBeInTheDocument());
  expect(screen.getByText("PCNA").closest("a")).toHaveAttribute("href", "/invoices/pcna");
  // No finance capability -> no vendor card.
  expect(screen.queryByText("Vendor Invoices")).not.toBeInTheDocument();
});

test("shows both when the user has finance access AND a tracker", async () => {
  route({ caps: { capabilities: ["finance.invoices.view"] }, trackers: { trackers: [{ id: "pcna", company: "PCNA" }] } });
  render(<InvoicesHubPage />);
  await waitFor(() => expect(screen.getByText("PCNA")).toBeInTheDocument());
  expect(screen.getByText("Vendor Invoices")).toBeInTheDocument();
  expect(screen.getAllByTestId("invoices-hub-card")).toHaveLength(2);
});

test("shows an empty state when the user has neither", async () => {
  route({ caps: { capabilities: [] }, trackers: { trackers: [] } });
  render(<InvoicesHubPage />);
  await screen.findByTestId("invoices-hub-empty");
});
