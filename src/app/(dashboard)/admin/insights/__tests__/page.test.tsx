/**
 * @jest-environment jsdom
 *
 * /admin/insights — DOM render: auth gate, fan-out to three feeds,
 * graceful failure when one feed 5xx's, empty state.
 */

import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";

const mockGetUser = jest.fn();
const mockFetch = jest.fn();
const mockPush = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));
jest.mock("@/lib/client-auth", () => ({
  getInstinctUser: () => mockGetUser(),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
}));

import InsightsAdminPage from "@/app/(dashboard)/admin/insights/page";

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const errJson = (status = 500) =>
  ({ ok: false, status, json: async () => ({}) }) as unknown as Response;

beforeEach(() => {
  mockGetUser.mockReset();
  mockFetch.mockReset();
  mockPush.mockReset();
});

describe("InsightsAdminPage", () => {
  test("redirects to /login when unauthenticated", () => {
    mockGetUser.mockReturnValue(null);
    render(<InsightsAdminPage />);
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining("/login"));
  });

  test("redirects non-admin role to /", () => {
    mockGetUser.mockReturnValue({ role: "dev" });
    render(<InsightsAdminPage />);
    expect(mockPush).toHaveBeenCalledWith("/");
  });

  test("admin sees three feeds with their data", async () => {
    mockGetUser.mockReturnValue({ role: "cto" });
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("unmet-intents")) {
        return Promise.resolve(
          okJson({
            intents: [
              {
                normalizedText: "show my deals",
                exampleText: "Show my deals",
                count: 4,
                lastSeenAt: "2026-05-17T10:00:00Z",
                distinctUsers: 3,
                brainContextRate: 0,
              },
            ],
          }),
        );
      }
      if (url.includes("/templates")) {
        return Promise.resolve(
          okJson({
            templates: [
              {
                id: "t1",
                templateId: "calendar_widget",
                surface: "widget",
                vendor: "microsoft",
                objectType: "event",
                useCases: ["See the month at a glance"],
                lastKnownSchemaHash: "h",
                fallbackFieldSet: [],
                notes: null,
                isActive: true,
              },
            ],
          }),
        );
      }
      if (url.includes("/health/integrations")) {
        return Promise.resolve(
          okJson({
            vendors: [
              {
                vendor: "microsoft",
                connectivity: { ok: true, statusCode: null, errorMessage: null, probedAt: "t" },
                schema: [
                  { objectType: "task", ok: true, schemaHash: "abc123def456", drifted: false, errorMessage: null, probedAt: "t" },
                ],
              },
            ],
          }),
        );
      }
      return Promise.resolve(errJson(404));
    });
    render(<InsightsAdminPage />);
    await waitFor(() => {
      expect(screen.getByTestId("insights-admin-page")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText("Show my deals")).toBeInTheDocument();
      expect(screen.getByText("calendar_widget")).toBeInTheDocument();
      /* "microsoft" appears in both the template row + the health
       * card heading, so use getAllByText. */
      expect(screen.getAllByText("microsoft").length).toBeGreaterThanOrEqual(1);
    });
  });

  test("surfaces an error banner when a feed fails but renders the others", async () => {
    mockGetUser.mockReturnValue({ role: "cto" });
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("unmet-intents")) return Promise.resolve(errJson(500));
      if (url.includes("/templates")) return Promise.resolve(okJson({ templates: [] }));
      if (url.includes("/health/integrations")) return Promise.resolve(okJson({ vendors: [] }));
      return Promise.resolve(errJson(404));
    });
    render(<InsightsAdminPage />);
    await waitFor(() => {
      expect(screen.getByText(/unmet-intents: HTTP 500/)).toBeInTheDocument();
    });
  });

  test("empty intents state renders prompt to check back", async () => {
    mockGetUser.mockReturnValue({ role: "cto" });
    mockFetch.mockResolvedValue(okJson({ intents: [], templates: [], vendors: [] }));
    render(<InsightsAdminPage />);
    await waitFor(() => {
      expect(screen.getByText(/No unmet intents in the window/)).toBeInTheDocument();
    });
  });
});
