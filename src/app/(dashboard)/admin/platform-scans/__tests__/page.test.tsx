/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * UI tests for the platform-scan review surface (/admin/platform-scans).
 * Asserts: targets populate the platform selector; findings render with title +
 * severity + route + the PLATFORM label from a mocked GET; "Run scan" POSTs the
 * SELECTED platform + mode then the list reflects the refetch; Acknowledge POSTs
 * {status:"acknowledged"} to findings/{id} and drops the row; the empty state
 * shows when GET returns no findings. fetchWithRefresh is mocked + routed by
 * URL/method so targets vs list vs scan vs decide calls are asserted independently.
 */

const mockFetchWithRefresh = jest.fn();
// Default: an authenticated session so the page renders the command center
// rather than redirecting. The auth-redirect test overrides this to null.
const mockGetInstinctToken = jest.fn(() => "tok-123" as string | null);
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
  getInstinctToken: () => mockGetInstinctToken(),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import PlatformScansPage from "@/app/(dashboard)/admin/platform-scans/page";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkRes(body: unknown, opts: { ok?: boolean; status?: number } = {}): any {
  return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body };
}

const TARGETS = [
  { platform: "wolfpack-auto", baseUrl: "https://wolfpack-auto.vercel.app", hasStatic: true },
  { platform: "acme-crm", baseUrl: "https://acme.example.com", hasStatic: false },
];

function mkFinding(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "f-1",
    scanId: "scan-1",
    platform: "wolfpack-auto",
    route: "/inventory/checkout",
    severity: "critical",
    category: "broken_journey",
    title: "Checkout returns 500 after coupon apply",
    detail: "Applying a valid coupon throws on the payment step.",
    evidence: { status: 500, location: "/inventory/checkout", durationMs: 1240, expectedAuth: true },
    status: "open",
    createdAt: "t",
    ...over,
  };
}

const isTargets = (url: string) => url === "/api/admin/platform-scans/targets";
const isSummary = (url: string) => url.startsWith("/api/admin/platform-scans/summary");
const isList = (url: string, opts?: { method?: string }) =>
  !opts && url.startsWith("/api/admin/platform-scans") && !url.includes("/findings/") && !isSummary(url) && !isTargets(url);

// Default rollup the dashboard reads on mount / after scan / after the filter
// changes. Tests that care about specific counts override this per-call.
const SUMMARY = {
  total: 24,
  bySeverity: { critical: 3, high: 6, medium: 10, low: 5 },
  byCategory: { bug: 9, security: 13, ux_gap: 2 },
};
const SCANS = [
  { id: "scan-9", platform: "wolfpack-auto", baseUrl: "https://wolfpack-auto.vercel.app", routeCount: 12, findingCount: 4, criticalCount: 1, createdAt: "2026-06-26T00:00:00.000Z" },
];
const summaryRes = (over: { summary?: unknown; scans?: unknown } = {}) =>
  mkRes({ summary: over.summary ?? SUMMARY, scans: over.scans ?? SCANS });

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockGetInstinctToken.mockReset();
  mockGetInstinctToken.mockReturnValue("tok-123");
});

it("populates the platform selector from targets and labels findings by platform", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (isSummary(url)) return Promise.resolve(summaryRes());
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: [mkFinding()] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);

  // Selector reflects the targets, defaulting to the first.
  const select = (await screen.findByTestId("platform-select")) as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe("wolfpack-auto"));
  // Both targets are offered in the run selector (acme-crm also appears in the
  // findings filter, hence getAllBy).
  expect(within(select).getByRole("option", { name: "acme-crm" })).toBeInTheDocument();

  // Each finding shows WHICH platform it was scanned on.
  expect(await screen.findByTestId("finding-platform-f-1")).toHaveTextContent("wolfpack-auto");
});

it("Run scan POSTs the SELECTED platform + mode, then the list reflects the refetch", async () => {
  const before = mkFinding({ id: "f-1", title: "Old finding" });
  const after = mkFinding({ id: "f-2", title: "Fresh finding after scan", route: "/login" });
  let scanned = false;

  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (url === "/api/admin/platform-scans" && opts?.method === "POST") {
      scanned = true;
      return Promise.resolve(mkRes({ ok: true, platform: "wolfpack-auto", mode: "http", scanId: "scan-2", findingCount: 1, criticalCount: 1, findings: [after] }));
    }
    if (isSummary(url)) return Promise.resolve(summaryRes());
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: scanned ? [after] : [before] }));
    return Promise.resolve(mkRes({}));
  });

  render(<PlatformScansPage />);
  await screen.findByTestId("finding-row-f-1");
  const select = (await screen.findByTestId("platform-select")) as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe("wolfpack-auto"));

  fireEvent.click(screen.getByTestId("run-scan"));

  expect(await screen.findByTestId("finding-row-f-2")).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByTestId("finding-row-f-1")).not.toBeInTheDocument());
  expect(screen.getByTestId("scan-summary")).toHaveTextContent("wolfpack-auto");
  expect(screen.getByTestId("scan-summary")).toHaveTextContent("1 finding, 1 critical");

  const post = mockFetchWithRefresh.mock.calls.find((c) => c[0] === "/api/admin/platform-scans" && c[1]?.method === "POST");
  expect(JSON.parse(String(post![1].body))).toEqual({ platform: "wolfpack-auto", mode: "http" });
});

it("scanning a different selected platform posts THAT platform", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (url === "/api/admin/platform-scans" && opts?.method === "POST")
      return Promise.resolve(mkRes({ ok: true, platform: "acme-crm", mode: "http", scanId: "s", findingCount: 0, criticalCount: 0, findings: [] }));
    if (isSummary(url)) return Promise.resolve(summaryRes());
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: [] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);
  const select = (await screen.findByTestId("platform-select")) as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe("wolfpack-auto"));

  fireEvent.change(select, { target: { value: "acme-crm" } });
  fireEvent.click(screen.getByTestId("run-scan"));

  await waitFor(() => {
    const post = mockFetchWithRefresh.mock.calls.find((c) => c[0] === "/api/admin/platform-scans" && c[1]?.method === "POST");
    expect(post && JSON.parse(String(post[1].body))).toEqual({ platform: "acme-crm", mode: "http" });
  });
});

it("Acknowledge POSTs {status:'acknowledged'} to findings/{id} and drops the row", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (isSummary(url)) return Promise.resolve(summaryRes());
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: [mkFinding()] }));
    if (url.startsWith("/api/admin/platform-scans/findings/") && opts?.method === "POST") {
      return Promise.resolve(mkRes({ ok: true, finding: mkFinding({ status: "acknowledged" }) }));
    }
    return Promise.resolve(mkRes({}));
  });

  render(<PlatformScansPage />);
  await screen.findByTestId("finding-row-f-1");

  fireEvent.click(screen.getByTestId("ack-f-1"));
  await waitFor(() => expect(screen.queryByTestId("finding-row-f-1")).not.toBeInTheDocument());

  const post = mockFetchWithRefresh.mock.calls.find(
    (c) => String(c[0]).endsWith("/findings/f-1") && c[1]?.method === "POST",
  );
  expect(JSON.parse(String(post![1].body))).toEqual({ status: "acknowledged" });
});

it("shows the empty state when the GET returns no findings", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (isSummary(url)) return Promise.resolve(summaryRes());
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: [] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);
  expect(await screen.findByTestId("findings-empty")).toBeInTheDocument();
});

it("renders the severity rollup, category breakdown, and open total from the summary", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (isSummary(url)) return Promise.resolve(summaryRes());
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: [mkFinding()] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);

  await screen.findByTestId("findings-summary");
  expect(await screen.findByTestId("sev-count-critical")).toHaveTextContent("3");
  expect(screen.getByTestId("sev-count-high")).toHaveTextContent("6");
  expect(screen.getByTestId("sev-count-medium")).toHaveTextContent("10");
  expect(screen.getByTestId("sev-count-low")).toHaveTextContent("5");
  // Category breakdown uses the friendly labels, ordered by count.
  expect(screen.getByTestId("category-breakdown")).toHaveTextContent("Security 13");
  expect(screen.getByTestId("category-breakdown")).toHaveTextContent("Bug 9");
  expect(screen.getByTestId("category-breakdown")).toHaveTextContent("UX gap 2");
  expect(screen.getByTestId("open-total")).toHaveTextContent("24 open");
});

it("renders scan history rows from the mocked scans, with platform + counts", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (isSummary(url)) return Promise.resolve(summaryRes());
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: [] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);

  const row = await screen.findByTestId("scan-history-row-scan-9");
  expect(row).toHaveTextContent("wolfpack-auto");
  expect(row).toHaveTextContent("4 findings");
  expect(row).toHaveTextContent("1 critical");
});

it("renders a clean coverage health line for a fully-covered latest scan", async () => {
  const cleanScans = [
    { ...SCANS[0], id: "scan-clean", coverage: { attempted: 18, succeeded: 18, errored: 0, authRequired: true, authEstablished: true, coverageRatio: 1 }, degraded: false },
  ];
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (isSummary(url)) return Promise.resolve(summaryRes({ scans: cleanScans }));
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: [] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);
  const health = await screen.findByTestId("coverage-health");
  expect(health).toHaveAttribute("data-degraded", "false");
  expect(health).toHaveTextContent("Coverage: 18/18 routes, auth established");
  expect(health).toHaveTextContent("fully covered");
});

it("renders a loud incomplete-scan warning when the latest scan is degraded", async () => {
  const degradedScans = [
    { ...SCANS[0], id: "scan-deg", coverage: { attempted: 20, succeeded: 12, errored: 8, authRequired: true, authEstablished: false, coverageRatio: 0.6 }, degraded: true },
  ];
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (isSummary(url)) return Promise.resolve(summaryRes({ scans: degradedScans }));
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: [] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);
  const health = await screen.findByTestId("coverage-health");
  expect(health).toHaveAttribute("data-degraded", "true");
  expect(health).toHaveAttribute("role", "alert");
  // The warning names WHY and refuses to call it clean.
  expect(health).toHaveTextContent("Scan was incomplete");
  expect(health).toHaveTextContent("8 routes errored");
  expect(health).toHaveTextContent("auth not established");
  expect(health).toHaveTextContent("NOT a clean result");
  // The degraded run is badged in the history too.
  expect(await screen.findByTestId("scan-degraded-scan-deg")).toHaveTextContent("incomplete");
});

it("says coverage is unknown (never 'clean') for a legacy scan without coverage", async () => {
  const legacyScans = [{ ...SCANS[0], id: "scan-old", coverage: null, degraded: null }];
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (isSummary(url)) return Promise.resolve(summaryRes({ scans: legacyScans }));
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: [] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);
  const health = await screen.findByTestId("coverage-health");
  expect(health).toHaveAttribute("data-degraded", "unknown");
  expect(health).toHaveTextContent("Coverage unknown");
});

it("collapses scan history to 'No scans yet' when there are none", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (isSummary(url)) return Promise.resolve(summaryRes({ scans: [] }));
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: [] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);
  expect(await screen.findByTestId("scan-history-empty")).toHaveTextContent("No scans yet");
});

it("defaults the list to the actionable band (critical+high) — GETs ?severity=critical,high", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (isSummary(url)) return Promise.resolve(summaryRes());
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: [mkFinding()] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);
  await screen.findByTestId("finding-row-f-1");

  // The findings GET carries the default actionable band so low smells never load.
  await waitFor(() => {
    const listCall = mockFetchWithRefresh.mock.calls.find(
      (c) => isList(String(c[0]), c[1]) && String(c[0]).includes("severity="),
    );
    expect(listCall).toBeTruthy();
    expect(String(listCall![0])).toContain("severity=critical%2Chigh");
  });
  // The actionable chip is the active one by default.
  expect(screen.getByTestId("severity-chip-actionable")).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByTestId("severity-chip-all")).toHaveAttribute("aria-pressed", "false");
});

it("summary shows FULL counts even though the list is filtered, with a 'show all' for hidden lower-severity", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (isSummary(url)) return Promise.resolve(summaryRes());
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: [mkFinding()] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);

  // Rollup is unfiltered: medium 10 + low 5 still shown (once the summary loads).
  await waitFor(() => expect(screen.getByTestId("sev-count-medium")).toHaveTextContent("10"));
  expect(screen.getByTestId("sev-count-low")).toHaveTextContent("5");
  // 10 medium + 5 low = 15 hidden by the actionable band -> surfaced as "show all".
  expect(screen.getByTestId("show-all-severities")).toHaveTextContent("+15 lower-severity hidden");
});

it("'show all' widens the list to every severity — re-GETs without a severity param", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (isSummary(url)) return Promise.resolve(summaryRes());
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: [mkFinding()] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);
  await screen.findByTestId("finding-row-f-1");

  fireEvent.click(screen.getByTestId("show-all-severities"));

  await waitFor(() => {
    // After widening, the most recent list GET carries no severity filter.
    const listCalls = mockFetchWithRefresh.mock.calls.filter((c) => isList(String(c[0]), c[1]));
    const last = listCalls[listCalls.length - 1];
    expect(String(last[0])).not.toContain("severity=");
  });
  expect(screen.getByTestId("severity-chip-all")).toHaveAttribute("aria-pressed", "true");
  // Hidden affordance collapses once all severities are shown.
  expect(screen.queryByTestId("show-all-severities")).not.toBeInTheDocument();
});

it("'Acknowledge all shown' POSTs the active severity filter to the bulk endpoint, then reloads", async () => {
  let acked = false;
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (url === "/api/admin/platform-scans/findings/bulk" && opts?.method === "POST") {
      acked = true;
      return Promise.resolve(mkRes({ ok: true, count: 1 }));
    }
    if (isSummary(url)) return Promise.resolve(summaryRes());
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: acked ? [] : [mkFinding()] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);
  await screen.findByTestId("finding-row-f-1");

  fireEvent.click(screen.getByTestId("bulk-acknowledge"));

  // Posted the ACTIVE band (default actionable critical+high).
  await waitFor(() => {
    const post = mockFetchWithRefresh.mock.calls.find(
      (c) => c[0] === "/api/admin/platform-scans/findings/bulk" && c[1]?.method === "POST",
    );
    expect(post).toBeTruthy();
    expect(JSON.parse(String(post![1].body))).toEqual({ status: "acknowledged", severity: "critical,high" });
  });
  // Reloaded -> the now-empty list shows the empty state.
  await waitFor(() => expect(screen.queryByTestId("finding-row-f-1")).not.toBeInTheDocument());
});

it("'Resolve all shown' confirms before posting; cancelling makes no call", async () => {
  const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(false);
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (isSummary(url)) return Promise.resolve(summaryRes());
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: [mkFinding()] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);
  await screen.findByTestId("finding-row-f-1");

  fireEvent.click(screen.getByTestId("bulk-resolve"));
  expect(confirmSpy).toHaveBeenCalled();
  const post = mockFetchWithRefresh.mock.calls.find(
    (c) => c[0] === "/api/admin/platform-scans/findings/bulk" && c[1]?.method === "POST",
  );
  expect(post).toBeUndefined();
  confirmSpy.mockRestore();
});

it("dimmed-but-present pills render for zero counts", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (isSummary(url)) return Promise.resolve(summaryRes({ summary: { total: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0 }, byCategory: {} } }));
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: [] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);
  expect(await screen.findByTestId("sev-count-critical")).toHaveTextContent("0");
  expect(screen.getByTestId("open-total")).toHaveTextContent("0 open");
  // Category breakdown collapses out when nothing to show.
  expect(screen.queryByTestId("category-breakdown")).not.toBeInTheDocument();
});

it("renders the UX posture grade chip from the summary's uxPosture", async () => {
  const UX_POSTURE = { grade: "D", ux: 1, a11y: 2, total: 3, bySeverity: { high: 1, medium: 0, low: 2 }, score: 12 };
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (isSummary(url)) return Promise.resolve(mkRes({ summary: SUMMARY, scans: SCANS, uxPosture: UX_POSTURE }));
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: [] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);

  const badge = await screen.findByTestId("ux-posture");
  expect(badge).toHaveAttribute("data-grade", "D");
  expect(screen.getByTestId("ux-posture-grade")).toHaveTextContent("D");
  expect(screen.getByTestId("ux-posture-split")).toHaveTextContent("1 UX");
  expect(screen.getByTestId("ux-posture-split")).toHaveTextContent("2 accessibility");
  expect(screen.getByTestId("ux-posture-split")).toHaveTextContent("3 total");
  // Empty state is NOT shown when a grade exists.
  expect(screen.queryByTestId("ux-posture-empty")).not.toBeInTheDocument();
});

it("shows the 'No UX scan yet' empty state when uxPosture is absent (never blank)", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    // Older summary response: no uxPosture field.
    if (isSummary(url)) return Promise.resolve(mkRes({ summary: SUMMARY, scans: SCANS }));
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: [] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);

  expect(await screen.findByTestId("ux-posture-empty")).toBeInTheDocument();
  expect(screen.queryByTestId("ux-posture")).not.toBeInTheDocument();
});

// --- Command-center redesign: hero metrics, distribution, tones, auth guard ---

it("renders the hero metric tiles with the right counts from targets + summary", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (isSummary(url)) return Promise.resolve(summaryRes());
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: [mkFinding()] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);

  // Hero grid mounts with all six tiles.
  expect(await screen.findByTestId("hero-metrics")).toBeInTheDocument();
  // Targets tile = number of onboarded targets (2). Count-up may animate, so wait
  // for the final value.
  const targetsTile = await screen.findByTestId("metric-targets");
  await waitFor(() => expect(within(targetsTile).getByTestId("metric-value")).toHaveTextContent("2"));
  // Open + critical + high pull straight from the summary rollup.
  const openTile = screen.getByTestId("metric-open");
  await waitFor(() => expect(within(openTile).getByTestId("metric-value")).toHaveTextContent("24"));
  const criticalTile = screen.getByTestId("metric-critical");
  await waitFor(() => expect(within(criticalTile).getByTestId("metric-value")).toHaveTextContent("3"));
  const highTile = screen.getByTestId("metric-high");
  await waitFor(() => expect(within(highTile).getByTestId("metric-value")).toHaveTextContent("6"));
  // Last-scan tile names the most-recent platform.
  expect(within(screen.getByTestId("metric-last-scan")).getByText("wolfpack-auto")).toBeInTheDocument();
});

it("renders the severity-distribution bar with a segment per non-zero severity", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (isSummary(url)) return Promise.resolve(summaryRes());
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: [] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);

  expect(await screen.findByTestId("severity-distribution")).toBeInTheDocument();
  // Every severity in SUMMARY is non-zero, so all four segments render.
  await waitFor(() => expect(screen.getByTestId("severity-distribution-critical")).toBeInTheDocument());
  expect(screen.getByTestId("severity-distribution-high")).toBeInTheDocument();
  expect(screen.getByTestId("severity-distribution-medium")).toBeInTheDocument();
  expect(screen.getByTestId("severity-distribution-low")).toBeInTheDocument();
  // The empty band is NOT rendered when there are findings.
  expect(screen.queryByTestId("severity-distribution-empty")).not.toBeInTheDocument();
});

it("renders the empty distribution band when there are zero findings of any severity", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (isSummary(url)) return Promise.resolve(summaryRes({ summary: { total: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0 }, byCategory: {} } }));
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: [] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);

  expect(await screen.findByTestId("severity-distribution-empty")).toBeInTheDocument();
  expect(screen.queryByTestId("severity-distribution-critical")).not.toBeInTheDocument();
});

it("severity pills carry the correct tone — critical=error, high=warning, medium=gold, low=neutral", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (isSummary(url)) return Promise.resolve(summaryRes());
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: [mkFinding()] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);

  // The rollup pills (inside sev-count-*) carry the severity tone.
  const critPill = within(await screen.findByTestId("sev-count-critical")).getByTestId("status-pill");
  expect(critPill).toHaveAttribute("data-tone", "error");
  expect(within(screen.getByTestId("sev-count-high")).getByTestId("status-pill")).toHaveAttribute("data-tone", "warning");
  expect(within(screen.getByTestId("sev-count-medium")).getByTestId("status-pill")).toHaveAttribute("data-tone", "gold");
  expect(within(screen.getByTestId("sev-count-low")).getByTestId("status-pill")).toHaveAttribute("data-tone", "neutral");

  // The per-finding severity badge is a StatusPill with the matching tone.
  const findingSevPill = within(await screen.findByTestId("finding-severity-f-1")).getByTestId("status-pill");
  expect(findingSevPill).toHaveAttribute("data-tone", "error");
});

it("redirects an unauthenticated visitor to /login (never renders the command center blank)", async () => {
  // No token -> the auth guard fires the /login?next= redirect. jsdom's Location
  // is non-configurable in our toolchain (see the qr/__tests__ note), so we assert
  // the OBSERVABLE consequences here — the auth-pending placeholder renders, the
  // full command center does NOT, and no authenticated fetch is made while logged
  // out. The exact href is exercised in the Playwright e2e (unauth -> /login).
  mockGetInstinctToken.mockReturnValue(null);

  render(<PlatformScansPage />);

  expect(screen.getByTestId("platform-scans-auth-pending")).toBeInTheDocument();
  expect(screen.queryByTestId("platform-scans-page")).not.toBeInTheDocument();
  // No data fetches were made while logged out.
  expect(mockFetchWithRefresh).not.toHaveBeenCalled();
});

// --- Engagement analytics: the learning-loop wiring ---

// Every analytics POST the page fires through fetchWithRefresh -> /api/analytics.
const analyticsPosts = () =>
  mockFetchWithRefresh.mock.calls.filter(
    (c) => String(c[0]) === "/api/analytics" && (c[1] as { method?: string } | undefined)?.method === "POST",
  );
const analyticsBodies = () => analyticsPosts().map((c) => JSON.parse(String((c[1] as { body: string }).body)));

it("fires platform.results_viewed ONCE on authed mount with the loaded summary + target counts", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (isSummary(url)) return Promise.resolve(summaryRes());
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: [mkFinding()] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);

  // One results_viewed event fires after the first successful summary load.
  await waitFor(() =>
    expect(analyticsBodies().filter((b) => b.event === "platform.results_viewed").length).toBe(1),
  );
  const viewed = analyticsBodies().find((b) => b.event === "platform.results_viewed");
  // open_total + critical + high from the rollup; targets from the loaded targets.
  expect(viewed.metadata).toEqual({ open_total: 24, critical: 3, high: 6, targets: 2 });
});

it("does NOT re-fire platform.results_viewed when the summary reloads (severity toggle)", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (isSummary(url)) return Promise.resolve(summaryRes());
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: [mkFinding()] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);
  await waitFor(() =>
    expect(analyticsBodies().filter((b) => b.event === "platform.results_viewed").length).toBe(1),
  );

  // Toggling the band reloads the summary; results_viewed must stay at exactly one.
  fireEvent.click(screen.getByTestId("severity-chip-all"));
  await waitFor(() =>
    expect(analyticsBodies().some((b) => b.event === "platform.severity_filter_toggled")).toBe(true),
  );
  expect(analyticsBodies().filter((b) => b.event === "platform.results_viewed").length).toBe(1);
});

it("fires platform.severity_filter_toggled with the band on each chip", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (isSummary(url)) return Promise.resolve(summaryRes());
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: [mkFinding()] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);
  await screen.findByTestId("finding-row-f-1");

  // "All severities" chip -> band: "all".
  fireEvent.click(screen.getByTestId("severity-chip-all"));
  await waitFor(() => {
    const all = analyticsBodies().find(
      (b) => b.event === "platform.severity_filter_toggled" && b.metadata.band === "all",
    );
    expect(all).toBeTruthy();
    expect(all.metadata.platform).toBe("all");
  });

  // "Actionable" chip -> band: "actionable".
  fireEvent.click(screen.getByTestId("severity-chip-actionable"));
  await waitFor(() =>
    expect(
      analyticsBodies().some(
        (b) => b.event === "platform.severity_filter_toggled" && b.metadata.band === "actionable",
      ),
    ).toBe(true),
  );
});

it("fires NO analytics on the auth-redirect (logged-out) path", async () => {
  mockGetInstinctToken.mockReturnValue(null);
  render(<PlatformScansPage />);
  expect(screen.getByTestId("platform-scans-auth-pending")).toBeInTheDocument();
  // The auth guard returns before any fetch, so no analytics (or data) call fires.
  expect(mockFetchWithRefresh).not.toHaveBeenCalled();
});

it("renders the findings error state when the list GET fails", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
    if (isSummary(url)) return Promise.resolve(summaryRes());
    if (isList(url, opts)) return Promise.resolve(mkRes({}, { ok: false, status: 500 }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);

  const err = await screen.findByTestId("findings-error");
  expect(err).toHaveTextContent("HTTP 500");
  // The shell still rendered (not blank): the hero + run controls are present.
  expect(screen.getByTestId("platform-scans-page")).toBeInTheDocument();
  expect(screen.getByTestId("run-scan")).toBeInTheDocument();
});
