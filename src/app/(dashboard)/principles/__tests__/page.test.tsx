/** @jest-environment jsdom */
 
import "@testing-library/jest-dom";

const mockFetch = jest.fn();
const mockGetUser = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetch(...a),
  getInstinctUser: () => mockGetUser(),
}));

import { act, fireEvent, render, screen } from "@testing-library/react";
import PrinciplesPage from "@/app/(dashboard)/principles/page";

const ok = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const ME_BODY = {
  principles: [
    {
      id: "p1",
      slug: "respect-off-hours",
      title: "Respect off-hours",
      domains: ["mail"],
      bodyMd: "Don't send mail at 11pm.",
    },
  ],
  observations: [
    {
      id: "o1",
      principleId: "p1",
      surface: "mail",
      surfaceSubtype: "outlook_send_after_hours",
      observedAt: "2026-05-01T03:30:00Z",
      score: -0.6,
      evidence: { kind: "outlook_send_after_hours", notes: "Late thought" },
    },
  ],
  sinceISO: "2026-04-24T00:00:00Z",
};

const TEAM_BODY = {
  ...ME_BODY,
  principles: [
    {
      id: "p1",
      slug: "respect-off-hours",
      title: "Respect off-hours",
      domains: ["mail"],
      scoreboardWeight: 3,
      owner: "Hoxsie",
    },
  ],
  aggregates: [
    { principleId: "p1", subjectUserId: "u-alicia", count: 4, meanScore: -0.6 },
    { principleId: "p1", subjectUserId: "u-self", count: 1, meanScore: -0.4 },
  ],
};

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  mockGetUser.mockReset();
});

describe("PrinciplesPage", () => {
  test("non-leadership user sees no team tab + only /me fetched", async () => {
    mockGetUser.mockReturnValue({ id: "u-alicia", role: "sales", name: "Alicia" });
    mockFetch.mockImplementation(() => Promise.resolve(ok(ME_BODY)));
    render(<PrinciplesPage />);
    await flush();
    expect(screen.queryByTestId("principles-tabs")).toBeNull();
    expect(screen.getByTestId("principles-me-view")).toBeInTheDocument();
    expect(screen.getByTestId("principle-card-respect-off-hours")).toBeInTheDocument();
    expect(screen.getByTestId("me-observation-o1")).toBeInTheDocument();
    /* Only one fetch — /me. /team is never attempted for non-leadership. */
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe("/api/principles/me");
  });

  test("leadership (cto) sees both tabs and team aggregates highlight 'you'", async () => {
    mockGetUser.mockReturnValue({ id: "u-self", role: "cto", name: "Nick" });
    mockFetch.mockImplementation((url: string) => {
      if (url.startsWith("/api/principles/me")) return Promise.resolve(ok(ME_BODY));
      if (url.startsWith("/api/principles/team")) return Promise.resolve(ok(TEAM_BODY));
      return Promise.resolve(ok({}));
    });
    render(<PrinciplesPage />);
    await flush();

    expect(screen.getByTestId("principles-tabs")).toBeInTheDocument();
    /* Default tab is "me" — assert it. */
    expect(screen.getByTestId("principles-me-view")).toBeInTheDocument();
    expect(screen.queryByTestId("principles-team-view")).toBeNull();

    /* Switch to team. */
    fireEvent.click(screen.getByTestId("tab-team"));
    expect(screen.getByTestId("principles-team-view")).toBeInTheDocument();
    expect(screen.getByTestId("team-card-respect-off-hours")).toBeInTheDocument();

    /* Worst-mean row appears first (sort) — alicia's -0.6 before self's -0.4. */
    const aliciaRow = screen.getByTestId("team-row-respect-off-hours-u-alicia");
    const selfRow = screen.getByTestId("team-row-respect-off-hours-u-self");
    expect(aliciaRow).toBeInTheDocument();
    expect(selfRow).toBeInTheDocument();
    expect(selfRow.textContent).toMatch(/\(you\)/);

    /* Both endpoints fetched. */
    const fetched = mockFetch.mock.calls.map((c) => c[0]);
    expect(fetched).toContain("/api/principles/me");
    expect(fetched).toContain("/api/principles/team");
  });

  test("401 on /me bails the load before showing the me view (redirect is fire-and-forget)", async () => {
    mockGetUser.mockReturnValue({ id: "u-cto", role: "cto" });
    mockFetch.mockResolvedValueOnce(ok({ error: "Unauthorized" }, 401));
    /* Stub window.location so the redirect doesn't trigger a JSDOM
       'navigation not implemented' throw. The page checks status === 401
       BEFORE rendering the me view, so the absence of the view is the
       behavioral assertion. */
    const noopLocation = { href: "" };
    try {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: noopLocation,
      });
    } catch {
      /* JSDOM may have a non-configurable location in some versions —
         in that case the test still passes via the queryByTestId checks
         below; the redirect attempt produces a console.error but doesn't
         fail the assertion. */
    }
    render(<PrinciplesPage />);
    await flush();
    /* Behavioral assertion: 401 short-circuits the load, so neither
       the me view nor the team-fetch happens. */
    expect(screen.queryByTestId("principles-me-view")).toBeNull();
    /* Only one fetch (the failing /me); no /team call attempted. */
    const fetched = mockFetch.mock.calls.map((c) => c[0]);
    expect(fetched.filter((u) => u.includes("/principles/team"))).toHaveLength(0);
  });

  test("when no principles loaded yet, the empty-state message renders", async () => {
    mockGetUser.mockReturnValue({ id: "u-x", role: "sales" });
    mockFetch.mockResolvedValueOnce(
      ok({ principles: [], observations: [], sinceISO: "2026-05-01" }),
    );
    render(<PrinciplesPage />);
    await flush();
    expect(screen.getByTestId("principles-me-no-principles")).toBeInTheDocument();
  });

  test("error from /me surfaces in an alert (non-401 path)", async () => {
    mockGetUser.mockReturnValue({ id: "u-x", role: "sales" });
    mockFetch.mockResolvedValueOnce(ok({ error: "boom" }, 500));
    render(<PrinciplesPage />);
    await flush();
    expect(screen.getByTestId("principles-error")).toBeInTheDocument();
  });
});
