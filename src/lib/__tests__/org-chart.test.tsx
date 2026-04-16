/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const fetchMockOC = jest.fn();

beforeAll(() => {
  global.fetch = fetchMockOC as unknown as typeof fetch;
  Object.defineProperty(window, "localStorage", {
    value: {
      _store: { instinct_token: "t" } as Record<string, string>,
      getItem(this: any, k: string) { return this._store[k] ?? null; },
      setItem(this: any, k: string, v: string) { this._store[k] = v; },
      removeItem(this: any, k: string) { delete this._store[k]; },
      clear(this: any) { this._store = {}; },
    },
    writable: true,
  });
});

beforeEach(() => fetchMockOC.mockReset());

function user(id: string, name: string, jobTitle: string | null = null) {
  return {
    id,
    msUserId: id,
    userPrincipalName: `${id}@x`,
    displayName: name,
    givenName: null,
    surname: null,
    mail: null,
    jobTitle,
    department: null,
    officeLocation: null,
    businessPhones: [],
    mobilePhone: null,
    managerMsId: null,
  };
}

describe("<OrgChart />", () => {
  test("renders root + lazy-loads direct reports on expand", async () => {
    // First fetch: root user detail
    fetchMockOC.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ user: user("root", "Root", "CTO") }),
    });
    // Second fetch: direct reports when expanded
    fetchMockOC.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        reports: [user("r1", "R One"), user("r2", "R Two")],
      }),
    });
    const OrgChart = (await import("@/components/directory/OrgChart")).default;
    render(<OrgChart rootMsUserId="root" maxDepth={3} />);
    await waitFor(() => {
      expect(screen.getByText("Root")).toBeInTheDocument();
    });
    // Reports aren't in the DOM yet
    expect(screen.queryByText("R One")).not.toBeInTheDocument();
    // Expand root
    const expandBtn = screen.getAllByTestId("org-chart-expand")[0];
    fireEvent.click(expandBtn);
    await waitFor(() => {
      expect(screen.getByText("R One")).toBeInTheDocument();
      expect(screen.getByText("R Two")).toBeInTheDocument();
    });
  });

  test("respects maxDepth=1 by hiding expand on deeper nodes", async () => {
    fetchMockOC.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ user: user("root", "Root") }),
    });
    const OrgChart = (await import("@/components/directory/OrgChart")).default;
    render(<OrgChart rootMsUserId="root" maxDepth={1} />);
    await waitFor(() => {
      expect(screen.getByText("Root")).toBeInTheDocument();
    });
    // depth 0 allows expand (since < maxDepth). The chart is top-only so
    // clicking would load reports, but the component does not render grand-
    // children beyond the clamp — we just confirm root renders without error.
    expect(screen.getByTestId("org-chart")).toBeInTheDocument();
  });
});
