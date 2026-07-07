/**
 * @jest-environment jsdom
 *
 * Every Invoices sub-page must offer a breadcrumb back to the hub (the gap the
 * user flagged). These render the server sub-pages and assert the "← Invoices"
 * link points at /invoices. fetchWithRefresh is mocked so the embedded panels
 * don't hit the network.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import InvoiceTrackerPage from "../[company]/page";
import VendorInvoicesPage from "../vendor/page";

beforeEach(() => {
  jest.resetAllMocks();
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});

test("PCNA tracker sub-page has a breadcrumb back to /invoices", async () => {
  const ui = await InvoiceTrackerPage({ params: Promise.resolve({ company: "pcna" }) });
  render(ui);
  const crumb = screen.getByTestId("invoice-tracker-breadcrumb");
  expect(crumb).toHaveAttribute("href", "/invoices");
  expect(crumb.textContent).toMatch(/invoices/i);
});

test("Vendor Invoices sub-page has a breadcrumb back to /invoices", () => {
  render(<VendorInvoicesPage />);
  const crumb = screen.getByTestId("vendor-invoices-breadcrumb");
  expect(crumb).toHaveAttribute("href", "/invoices");
});
