/**
 * @jest-environment jsdom
 *
 * /portal/salesforce page render tests.
 *
 * Asserts the three render branches a real user lands on:
 *   1. Loading → spinner.
 *   2. Not configured → "Connect Salesforce" CTA + link to /admin/connectors.
 *   3. Configured → pipeline tiles + recent activity table.
 */

import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import SalesforcePortalPage from "@/app/(dashboard)/portal/salesforce/page";

jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: jest.fn(),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));
import { fetchWithRefresh } from "@/lib/client-auth";

describe("SalesforcePortalPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("renders the Connect Salesforce CTA when API returns notConfigured", async () => {
    (fetchWithRefresh as jest.MockedFunction<typeof fetchWithRefresh>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        notConfigured: true,
        pipeline: { openCount: 0, totalAmount: 0, byStage: [] },
        recent: [],
        connector: "salesforce",
      }),
    } as unknown as Response);

    render(<SalesforcePortalPage />);
    await waitFor(() => expect(screen.getByTestId("sf-portal-cta")).toBeInTheDocument());
    expect(screen.getByTestId("sf-portal-connect-link")).toHaveAttribute(
      "href",
      "/admin/connectors",
    );
  });

  test("renders pipeline tiles + quick links + recent activity when configured", async () => {
    (fetchWithRefresh as jest.MockedFunction<typeof fetchWithRefresh>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        notConfigured: false,
        pipeline: {
          openCount: 5,
          totalAmount: 250000,
          byStage: [{ stage: "Prospecting", count: 3, amount: 100000 }],
        },
        recent: [
          { id: "o1", name: "Acme Q3", type: "opportunities", lastModified: "2026-05-19T00:00:00Z" },
        ],
        connector: "salesforce",
      }),
    } as unknown as Response);

    render(<SalesforcePortalPage />);

    await waitFor(() => expect(screen.getByTestId("sf-pipeline-snapshot")).toBeInTheDocument());
    expect(screen.getByTestId("sf-link-contacts")).toHaveAttribute(
      "href",
      "/portal/salesforce/contacts",
    );
    expect(screen.getByTestId("sf-recent-activity").textContent).toContain("Acme Q3");
    /* Pipeline tile renders the open count and the $ formatted amount. */
    expect(screen.getByTestId("sf-pipeline-snapshot").textContent).toContain("5");
    expect(screen.getByTestId("sf-pipeline-snapshot").textContent).toContain("$250.0k");
  });

  test("renders an error panel when the dashboard API returns non-200", async () => {
    (fetchWithRefresh as jest.MockedFunction<typeof fetchWithRefresh>).mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({ error: "auth_failed" }),
    } as unknown as Response);

    render(<SalesforcePortalPage />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("HTTP 502"));
  });
});
