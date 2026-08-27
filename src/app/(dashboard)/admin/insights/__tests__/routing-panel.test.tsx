/**
 * @jest-environment jsdom
 *
 * The routing-coverage panel on /admin/insights.
 *
 * It sits beside the role-mismatch panel because they answer the same question
 * from opposite ends: that one names a control shown to somebody who could not
 * use it, this one names a sentence somebody typed that reached nothing. The
 * operator asked for the number to be somewhere it would be seen, because a
 * number nobody prints is a number nobody improves.
 *
 * The unreadable case is asserted hardest. A panel that renders 0% because the
 * endpoint failed would be reporting a catastrophe that had not happened, on
 * the page the company uses to decide what to build.
 */

import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";

const mockGetUser = jest.fn();
const mockFetch = jest.fn();
const mockPush = jest.fn();

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock("@/lib/client-auth", () => ({
  getInstinctUser: () => mockGetUser(),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
}));

import InsightsAdminPage from "@/app/(dashboard)/admin/insights/page";

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

const ROUTING = {
  readable: true,
  total: 36,
  reachedOne: 30,
  reachedNone: 4,
  reachedMany: 2,
  percent: 83,
  deadClusters: [] as string[],
  unreachable: ["who emailed me today", "what does the SOW say"],
};

function routeWith(routing: unknown) {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes("routing-coverage")) return Promise.resolve(okJson(routing));
    if (url.includes("role-mismatches")) return Promise.resolve(okJson({ mismatches: [], readable: true }));
    if (url.includes("unmet-intents")) return Promise.resolve(okJson({ intents: [] }));
    if (url.includes("/templates")) return Promise.resolve(okJson({ templates: [] }));
    return Promise.resolve(okJson({ vendors: [] }));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockReturnValue({ role: "cto" });
});

describe("the routing panel", () => {
  it("shows the score and the shape of the corpus", async () => {
    routeWith(ROUTING);
    render(<InsightsAdminPage />);
    /* Waits on the VALUE, not the section. The section renders immediately with
       a loading line, so waiting on it races the state update. */
    await waitFor(() => expect(screen.getByTestId("routing-percent")).toHaveTextContent("83%"));
    expect(screen.getByText(/30 of 36 reach exactly one tool/)).toBeInTheDocument();
  });

  it("lists the prompts that reach nothing, so the next fix is nameable", async () => {
    routeWith(ROUTING);
    render(<InsightsAdminPage />);
    await waitFor(() => expect(screen.getByTestId("routing-unreachable-list")).toBeInTheDocument());
    expect(screen.getByText("who emailed me today")).toBeInTheDocument();
  });

  it("calls out a wholly dead cluster as a missing capability", async () => {
    routeWith({ ...ROUTING, deadClusters: ["status"] });
    render(<InsightsAdminPage />);
    await waitFor(() => expect(screen.getByTestId("routing-dead-clusters")).toBeInTheDocument());
    expect(screen.getByTestId("routing-dead-clusters")).toHaveTextContent(/no regex will fix them/i);
  });

  it("hides the dead-cluster warning when there are none", async () => {
    routeWith(ROUTING);
    render(<InsightsAdminPage />);
    await waitFor(() => expect(screen.getByTestId("routing-percent")).toBeInTheDocument());
    expect(screen.queryByTestId("routing-dead-clusters")).not.toBeInTheDocument();
  });

  it("says unreadable rather than showing zero percent", async () => {
    routeWith({ readable: false, error: "registry broken" });
    render(<InsightsAdminPage />);
    await waitFor(() => expect(screen.getByTestId("routing-unreadable")).toBeInTheDocument());
    expect(screen.queryByTestId("routing-percent")).not.toBeInTheDocument();
    expect(screen.getByTestId("routing-unreadable")).toHaveTextContent(/not a score of zero/i);
  });

  it("shows n/a rather than 0% for an empty corpus", async () => {
    routeWith({ ...ROUTING, percent: null, total: 0, reachedOne: 0 });
    render(<InsightsAdminPage />);
    await waitFor(() => expect(screen.getByTestId("routing-percent")).toBeInTheDocument());
    expect(screen.getByTestId("routing-percent")).toHaveTextContent("n/a");
  });
});
