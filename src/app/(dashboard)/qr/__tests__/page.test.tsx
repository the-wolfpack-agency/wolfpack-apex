/** @jest-environment jsdom */
 
import "@testing-library/jest-dom";

/**
 * /qr page UI tests.
 *
 * Locks:
 *   - Renders create-form fields when authed
 *   - Posts to /api/qr with the assembled body and prepends the new code
 *   - Renders existing codes from initial GET /api/qr
 *   - Analytics panel toggles on click and renders KPIs + the SVG line
 *     chart when GET /api/qr/[id]/analytics resolves
 *   - Archive confirms then DELETEs
 *   - Redirects to /login?next=/qr when no token is present
 */

const mockFetchWithRefresh = jest.fn();
const mockGetInstinctToken = jest.fn();

jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  jsonHeaders: () => ({
    "Content-Type": "application/json",
    Authorization: "Bearer x",
  }),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  getInstinctToken: (...a: any[]) => mockGetInstinctToken(...a),
}));

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import QrPage from "@/app/(dashboard)/qr/page";

/* ----------------------------- fixtures ----------------------------- */

const sampleCode = {
  id: "code-1",
  slug: "abc1234",
  targetUrl: "https://example.com/landing",
  label: "Spring brochure",
  utmCampaign: "spring-brochure",
  expiresAt: null,
  archivedAt: null,
  createdAt: "2026-04-29T10:00:00.000Z",
  createdByUserId: "u1",
  createdByUserRole: "ceo",
};

const sampleCode2 = {
  id: "code-2",
  slug: "xyz9876",
  targetUrl: "https://example.com/promo",
  label: null,
  utmCampaign: null,
  expiresAt: null,
  archivedAt: null,
  createdAt: "2026-04-28T10:00:00.000Z",
  createdByUserId: "u1",
  createdByUserRole: "ceo",
};

const sampleAnalytics = {
  total_scans: 42,
  unique_visitors: 31,
  blocked_scans: 1,
  last_scanned_at: "2026-04-29T12:00:00.000Z",
  by_day: [
    { day: "2026-04-27", count: 5 },
    { day: "2026-04-28", count: 12 },
    { day: "2026-04-29", count: 25 },
  ],
  by_country: [
    { country: "US", count: 30 },
    { country: "CA", count: 8 },
  ],
  by_device: [
    { device: "mobile", count: 30 },
    { device: "desktop", count: 12 },
  ],
  by_browser: [{ browser: "Chrome", count: 25 }],
  by_os: [{ os: "iOS", count: 20 }],
  by_hour: [
    { hour: 9, count: 10 },
    { hour: 14, count: 15 },
  ],
  top_referrers: [{ referrer: "instagram.com", count: 12 }],
  recent: [
    {
      scanned_at: "2026-04-29T12:00:00.000Z",
      country: "US",
      device: "mobile",
      browser: "Chrome",
      referrer: "instagram.com",
    },
  ],
};

/* ----------------------------- helpers ------------------------------ */

function mockListResponse(codes: unknown[]) {
  /* The first call after mount is GET /api/qr. */
  mockFetchWithRefresh.mockImplementationOnce(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ codes }),
    }),
  );
}

function findUrlArg(call: any[]): string {
  const arg = call[0];
  if (typeof arg === "string") return arg;
  return String(arg);
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockGetInstinctToken.mockReset();
  mockGetInstinctToken.mockReturnValue("tok");
  /* jsdom URL.createObjectURL stub for the Download SVG path. */
  if (typeof URL.createObjectURL === "undefined") {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: jest.fn(() => "blob:test"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: jest.fn(),
    });
  }
});

/* ------------------------------ tests ------------------------------- */

describe("/qr page", () => {
  test("does not render the main UI and consults getInstinctToken when no token is present (redirect path)", async () => {
    mockGetInstinctToken.mockReturnValue(null);

    /* jsdom won't let us reliably reassign window.location for this
       page (its Location object is non-configurable in our toolchain),
       and assigning .href triggers an actual jsdom navigation that
       cannot be cleanly intercepted. So we assert the *behavioural
       contract*: when there's no token, the page renders only the
       loading skeleton (auth gate stays unchecked) and never paints
       the main "qr-page" UI — which is what the redirect would
       prevent. The href assignment itself is exercised in E2E. */

    render(<QrPage />);

    /* Auth-check fired with no token. */
    await waitFor(() => {
      expect(mockGetInstinctToken).toHaveBeenCalled();
    });

    /* Page never advances past loading: it never sets authChecked,
       because the redirect path returns before that. */
    expect(screen.getByTestId("qr-page-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("qr-page")).toBeNull();
    expect(screen.queryByTestId("qr-create-form")).toBeNull();

    /* And — critically — no GET /api/qr fired, because we bailed out
       before hitting any authed endpoint. */
    const apiCalls = mockFetchWithRefresh.mock.calls.filter((c) =>
      String(c[0]).startsWith("/api/qr"),
    );
    expect(apiCalls).toHaveLength(0);
  });

  test("renders create-form fields and existing codes", async () => {
    mockListResponse([sampleCode, sampleCode2]);

    render(<QrPage />);

    /* Form fields are present once auth-check passes. */
    await waitFor(() =>
      expect(screen.getByTestId("qr-create-form")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("qr-create-label")).toBeInTheDocument();
    expect(screen.getByTestId("qr-create-target-url")).toBeInTheDocument();
    expect(screen.getByTestId("qr-create-utm")).toBeInTheDocument();
    expect(screen.getByTestId("qr-create-expires")).toBeInTheDocument();
    expect(screen.getByTestId("qr-create-submit")).toBeInTheDocument();

    /* Both existing codes render. */
    await waitFor(() =>
      expect(screen.getByTestId("qr-row-abc1234")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("qr-row-xyz9876")).toBeInTheDocument();
  });

  test("submitting create form posts the assembled body and prepends the new code", async () => {
    mockListResponse([sampleCode2]);
    /* Second call: the POST. */
    const newCode = {
      ...sampleCode,
      id: "code-3",
      slug: "new5678",
      label: "Promo flyer",
      utmCampaign: "promo-flyer",
      targetUrl: "https://example.com/x",
    };
    mockFetchWithRefresh.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          code: newCode,
          qrSvg: "<svg data-testid='inner-svg'></svg>",
          shortUrl: "/q/new5678",
          fullRedirectUrl: "https://wolfpack.test/q/new5678",
        }),
      }),
    );

    render(<QrPage />);
    await waitFor(() =>
      expect(screen.getByTestId("qr-create-form")).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByTestId("qr-create-label"), {
      target: { value: "Promo flyer" },
    });
    fireEvent.change(screen.getByTestId("qr-create-target-url"), {
      target: { value: "https://example.com/x" },
    });

    fireEvent.click(screen.getByTestId("qr-create-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("qr-latest-created")).toBeInTheDocument();
    });

    /* Find the POST call. */
    const postCall = mockFetchWithRefresh.mock.calls.find(
      (c) => c[1]?.method === "POST",
    );
    expect(postCall).toBeTruthy();
    expect(findUrlArg(postCall!)).toBe("/api/qr");
    const body = JSON.parse(postCall![1].body);
    expect(body.targetUrl).toBe("https://example.com/x");
    expect(body.label).toBe("Promo flyer");
    /* utm autofills from the slugified label. */
    expect(body.utmCampaign).toBe("promo-flyer");

    /* The new code is prepended to the list. */
    expect(screen.getByTestId("qr-row-new5678")).toBeInTheDocument();
    expect(screen.getByTestId("qr-row-xyz9876")).toBeInTheDocument();

    /* Latest-created surface shows the slug + buttons. */
    expect(screen.getByTestId("qr-latest-svg")).toBeInTheDocument();
    expect(screen.getByTestId("qr-latest-copy")).toBeInTheDocument();
    expect(screen.getByTestId("qr-latest-download")).toBeInTheDocument();
  });

  test("analytics panel toggles on click and renders KPIs + SVG chart when API resolves", async () => {
    mockListResponse([sampleCode]);
    /* When the user clicks "View analytics", we expect a GET. */
    mockFetchWithRefresh.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => sampleAnalytics,
      }),
    );

    render(<QrPage />);
    await waitFor(() =>
      expect(screen.getByTestId("qr-row-abc1234")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("qr-row-analytics-abc1234"));

    /* Analytics fetch fires. */
    await waitFor(() => {
      const analyticsCall = mockFetchWithRefresh.mock.calls.find(
        (c) =>
          typeof findUrlArg(c) === "string" &&
          findUrlArg(c).includes(`/api/qr/${encodeURIComponent("code-1")}/analytics`),
      );
      expect(analyticsCall).toBeTruthy();
    });

    /* KPI block + SVG line chart present. */
    await waitFor(() =>
      expect(screen.getByTestId("qr-analytics-kpis")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("qr-kpi-total")).toHaveTextContent("42");
    expect(screen.getByTestId("qr-kpi-unique")).toHaveTextContent("31");
    expect(screen.getByTestId("qr-kpi-blocked")).toHaveTextContent("1");
    expect(screen.getByTestId("qr-line-chart")).toBeInTheDocument();
    /* And the line chart drew at least one dot for the by_day series. */
    const dots = screen.getAllByTestId("qr-line-chart-dot");
    expect(dots.length).toBeGreaterThan(0);
    /* And the bar charts. */
    expect(screen.getByTestId("qr-bar-country")).toBeInTheDocument();
    expect(screen.getByTestId("qr-bar-device")).toBeInTheDocument();
    expect(screen.getByTestId("qr-bar-browser")).toBeInTheDocument();
    expect(screen.getByTestId("qr-hour-heatmap")).toBeInTheDocument();
    expect(screen.getByTestId("qr-recent-table")).toBeInTheDocument();

    /* Click again -> hides. */
    fireEvent.click(screen.getByTestId("qr-row-analytics-abc1234"));
    await waitFor(() => {
      expect(
        screen.queryByTestId("qr-row-analytics-panel-abc1234"),
      ).toBeNull();
    });
  });

  test("archive confirms then DELETEs and removes the row", async () => {
    mockListResponse([sampleCode, sampleCode2]);
    /* DELETE call. */
    mockFetchWithRefresh.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, code: sampleCode }),
      }),
    );

    const confirmSpy = jest
      .spyOn(window, "confirm")
      .mockImplementation(() => true);

    render(<QrPage />);
    await waitFor(() =>
      expect(screen.getByTestId("qr-row-abc1234")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("qr-row-archive-abc1234"));

    await waitFor(() => {
      const deleteCall = mockFetchWithRefresh.mock.calls.find(
        (c) => c[1]?.method === "DELETE",
      );
      expect(deleteCall).toBeTruthy();
      expect(findUrlArg(deleteCall!)).toContain(
        `/api/qr/${encodeURIComponent("code-1")}`,
      );
    });

    expect(confirmSpy).toHaveBeenCalled();

    /* The archived row is gone, the other one stays. */
    await waitFor(() => {
      expect(screen.queryByTestId("qr-row-abc1234")).toBeNull();
    });
    expect(screen.getByTestId("qr-row-xyz9876")).toBeInTheDocument();

    confirmSpy.mockRestore();
  });

  test("archive does NOT delete when confirm is dismissed", async () => {
    mockListResponse([sampleCode]);

    const confirmSpy = jest
      .spyOn(window, "confirm")
      .mockImplementation(() => false);

    render(<QrPage />);
    await waitFor(() =>
      expect(screen.getByTestId("qr-row-abc1234")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("qr-row-archive-abc1234"));

    /* Only the initial GET fired — no DELETE. */
    const deleteCalls = mockFetchWithRefresh.mock.calls.filter(
      (c) => c[1]?.method === "DELETE",
    );
    expect(deleteCalls).toHaveLength(0);

    /* Row still rendered. */
    expect(screen.getByTestId("qr-row-abc1234")).toBeInTheDocument();

    confirmSpy.mockRestore();
  });

  test("renders empty state when GET /api/qr returns []", async () => {
    mockListResponse([]);

    render(<QrPage />);

    await waitFor(() =>
      expect(screen.getByTestId("qr-list-empty")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("qr-list")).toBeNull();
    /* Within the empty-state container we still expect the create form. */
    expect(
      within(screen.getByTestId("qr-create-section")).getByTestId(
        "qr-create-form",
      ),
    ).toBeInTheDocument();
  });
});
