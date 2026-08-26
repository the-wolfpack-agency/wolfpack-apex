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

/**
 * Controls shown to roles that cannot use them.
 *
 * The other panels on this page describe what to build next. This one names
 * something already broken for somebody who never told us: they clicked, the
 * API correctly refused, and nothing happened on screen.
 *
 * The tests are mostly about the two ways this panel could mislead. Rendering
 * an empty table when the query failed would claim no control in the product
 * lies to anybody. And burying the repeat count would lose the only signal
 * that separates a real defect from a stale tab.
 */
const MISMATCH = {
  control: "/api/orgs/:id/users",
  method: "POST",
  surface: "/admin/team",
  role: "dealer",
  attempts: 3,
  people: 1,
  worstRepeat: 3,
  lastSeen: "2026-08-26",
};

/** The page fans out to four endpoints; only the last is under test here. */
function respondWith(mismatchBody: unknown, ok = true) {
  mockFetch.mockImplementation((url: string) => {
    if (String(url).includes("role-mismatches")) {
      return Promise.resolve(ok ? okJson(mismatchBody) : errJson(500));
    }
    return Promise.resolve(okJson({ intents: [], templates: [], vendors: [] }));
  });
}

describe("the role mismatch panel", () => {
  beforeEach(() => mockGetUser.mockReturnValue({ role: "cto" }));

  it("names the control, the page it is on, and the role that saw it", async () => {
    respondWith({ mismatches: [MISMATCH], readable: true });
    render(<InsightsAdminPage />);
    const panel = await screen.findByTestId("insights-role-mismatches");
    /* Each of the three is what makes the row actionable: what to remove,
       where to remove it from, and for whom. */
    expect(panel).toHaveTextContent("/api/orgs/:id/users");
    expect(panel).toHaveTextContent("/admin/team");
    expect(panel).toHaveTextContent("dealer");
  });

  /* The ranking key, and the reason the row is there at all. */
  it("shows the repeat count as the reason the row exists", async () => {
    respondWith({ mismatches: [MISMATCH], readable: true });
    render(<InsightsAdminPage />);
    const panel = await screen.findByTestId("insights-role-mismatches");
    expect(panel).toHaveTextContent(/3.*by one person/);
  });

  /* An empty table for a failed read would claim the product is clean. */
  it("says unreadable rather than showing no mismatches", async () => {
    respondWith({ mismatches: [], readable: false });
    render(<InsightsAdminPage />);
    expect(await screen.findByTestId("mismatches-unreadable")).toHaveTextContent(
      /not the same as no mismatches/i,
    );
  });

  it("distinguishes a genuinely clean window from an unreadable one", async () => {
    respondWith({ mismatches: [], readable: true });
    render(<InsightsAdminPage />);
    const panel = await screen.findByTestId("insights-role-mismatches");
    expect(panel).toHaveTextContent(/No refused controls in the window/i);
    expect(screen.queryByTestId("mismatches-unreadable")).not.toBeInTheDocument();
  });

  /* One panel failing must not take the page down: the other three still
     answer questions somebody came here for. */
  it("keeps the rest of the page when this endpoint fails", async () => {
    respondWith(null, false);
    render(<InsightsAdminPage />);
    expect(await screen.findByTestId("insights-unmet-intents")).toBeInTheDocument();
  });
});
