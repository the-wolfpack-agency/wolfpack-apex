/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({ fetchWithRefresh: (...a: unknown[]) => mockFetch(...a) }));
import { SitePageIntegrity } from "../SitePageIntegrity";

const ok = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
const EMPTY = { learning: null, origins: [], totals: { origins: 0, newOrigins: 0, wouldAlert: 0 } };

beforeEach(() => jest.clearAllMocks());

it("the cross-site view asks for a site and fetches nothing", () => {
  render(<SitePageIntegrity site="all" />);
  expect(screen.getByTestId("admin-page-integrity-pick")).toBeInTheDocument();
  expect(mockFetch).not.toHaveBeenCalled();
});

it("a selected site loads its report through fetchWithRefresh and renders the explicit empty state", async () => {
  mockFetch.mockResolvedValue(ok({ integrity: EMPTY }));
  render(<SitePageIntegrity site="aidanmulready" />);
  expect(await screen.findByTestId("admin-page-integrity-empty")).toBeInTheDocument();
  expect(mockFetch).toHaveBeenCalledWith("/api/admin/site-analytics/page-integrity?site=aidanmulready");
});

it.each([403, 500])("a %s answer shows a clear error, not a blank panel", async (status) => {
  mockFetch.mockResolvedValue(ok({ error: "x" }, status));
  render(<SitePageIntegrity site="ogiam.com" />);
  expect(await screen.findByTestId("admin-page-integrity-error")).toBeInTheDocument();
});
