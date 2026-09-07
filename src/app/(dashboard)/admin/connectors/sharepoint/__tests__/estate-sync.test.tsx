/**
 * @jest-environment jsdom
 *
 * The "Sync entire estate" button.
 *
 * One click walks every active source through the sync-all route. What matters
 * here is that the button calls the estate endpoint (not the per-source one),
 * reports the summary the route returns, tells the operator to click again when
 * the estate is only partly done (never as an error), and surfaces a failure
 * without wedging the button.
 */

import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockGetUser = jest.fn();
const mockFetch = jest.fn();
const mockPush = jest.fn();

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock("@/lib/client-auth", () => ({
  getInstinctUser: () => mockGetUser(),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
}));

import SharepointConnectorsPage from "@/app/(dashboard)/admin/connectors/sharepoint/page";

const SOURCE = {
  id: "src-1",
  name: "TEST",
  folderPath: "General",
  siteUrl: "https://x.sharepoint.com/sites/a",
  lastSyncedAt: "2026-05-16T15:57:05.551Z",
  isActive: true,
};

const res = (ok: boolean, status: number, body: unknown) =>
  ({ ok, status, json: async () => body }) as unknown as Response;

/** Wire GET sources + a scripted response for the sync-all POST. */
function wireEstate(estate: Response) {
  mockFetch.mockImplementation((url: string, init?: { method?: string }) => {
    if (String(url).includes("/sync-all") && init?.method === "POST") {
      return Promise.resolve(estate);
    }
    return Promise.resolve(res(true, 200, { sources: [SOURCE] }));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockReturnValue({ role: "cto", id: "u1" });
});

describe("Sync entire estate", () => {
  it("calls the sync-all endpoint and reports the summary", async () => {
    wireEstate(
      res(true, 200, {
        result: {
          sourcesProcessed: 3, sourcesSucceeded: 3, sourcesFailed: 0,
          filesIngested: 128, moreRemaining: false,
        },
      }),
    );
    render(<SharepointConnectorsPage />);
    await waitFor(() => expect(screen.getByTestId("estate-sync-button")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("estate-sync-button"));

    await waitFor(() =>
      expect(screen.getByTestId("estate-sync-result")).toHaveTextContent(
        "3 of 3 sources synced · 128 files indexed",
      ),
    );
    // It hit the estate route, not a per-source one.
    const calledSyncAll = mockFetch.mock.calls.some(
      ([u, init]) => String(u).includes("/sync-all") && (init as { method?: string })?.method === "POST",
    );
    expect(calledSyncAll).toBe(true);
  });

  it("says 'more remaining, click to continue' on a partial estate, not an error", async () => {
    wireEstate(
      res(true, 200, {
        result: {
          sourcesProcessed: 2, sourcesSucceeded: 2, sourcesFailed: 0,
          filesIngested: 90, moreRemaining: true,
        },
      }),
    );
    render(<SharepointConnectorsPage />);
    await waitFor(() => expect(screen.getByTestId("estate-sync-button")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("estate-sync-button"));

    await waitFor(() =>
      expect(screen.getByTestId("estate-sync-result")).toHaveTextContent("more remaining, click to continue"),
    );
    // A partial estate is progress, not a fault: no error box.
    expect(screen.queryByTestId("estate-sync-error")).not.toBeInTheDocument();
  });

  it("counts failed sources in the summary", async () => {
    wireEstate(
      res(true, 200, {
        result: {
          sourcesProcessed: 3, sourcesSucceeded: 2, sourcesFailed: 1,
          filesIngested: 40, moreRemaining: false,
        },
      }),
    );
    render(<SharepointConnectorsPage />);
    await waitFor(() => expect(screen.getByTestId("estate-sync-button")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("estate-sync-button"));

    await waitFor(() =>
      expect(screen.getByTestId("estate-sync-result")).toHaveTextContent("1 failed"),
    );
  });

  it("surfaces a server error without wedging the button", async () => {
    wireEstate(res(false, 500, { error: "Estate sync failed unexpectedly: boom" }));
    render(<SharepointConnectorsPage />);
    await waitFor(() => expect(screen.getByTestId("estate-sync-button")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("estate-sync-button"));

    await waitFor(() =>
      expect(screen.getByTestId("estate-sync-error")).toHaveTextContent("boom"),
    );
    // Button is enabled again so the operator can retry.
    expect(screen.getByTestId("estate-sync-button")).toBeEnabled();
  });
});
