/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * UI tests for the benchmark dashboard (/admin/benchmark).
 *
 * Asserts: the latest-run summary cards render from a runs payload (recall +
 * precision as percentages, coverage/labeled/errored counts); the learning-signal
 * backlog renders grouped by kind with the REAL LearningSignal fields
 * (findingClass + target + detail, matching scorer.ts); the trend table renders a
 * row per run; the explicit empty state shows for { runs: [] }; an error state
 * shows on a non-ok fetch. fetchWithRefresh is mocked + routed by URL; useRouter
 * is mocked so the auth-redirect guard is exercised without navigation.
 */

const mockFetchWithRefresh = jest.fn();
const mockPush = jest.fn();
let mockUser: unknown = { id: "u-1", role: "admin" };

jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
  getInstinctUser: () => mockUser,
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

import { render, screen, waitFor, within } from "@testing-library/react";
import BenchmarkDashboardPage from "@/app/(dashboard)/admin/benchmark/page";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkRes(body: unknown, opts: { ok?: boolean; status?: number } = {}): any {
  return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body };
}

const isBenchmark = (url: string) => url === "/api/admin/platform-scans/benchmark";
const isCompetitive = (url: string) =>
  url === "/api/admin/platform-scans/benchmark/competitive";

// Mirrors the GET .../benchmark/competitive response (comparison + improvement).
const COMPETITIVE = {
  ok: true,
  comparison: [
    {
      tool: "nuclei",
      label: "Nuclei",
      target: "vampi",
      runAt: "2026-06-28T10:00:00.000Z",
      theirs: { recall: 0.4, precision: 1, findings: 5 },
      ours: { recall: 0.6, precision: 1, matched: ["security:SQL injection"] },
      rivalOnlyGaps: [
        { findingClass: "security:Broken object level authorization (IDOR)", tools: ["nuclei"] },
      ],
      parity: false,
    },
  ],
  improvement: {
    series: [
      { runAt: "2026-06-27T10:00:00.000Z", recall: 0.5, coverageClasses: 9 },
      { runAt: "2026-06-28T10:00:00.000Z", recall: 0.6, coverageClasses: 12 },
    ],
    latestRecall: 0.6,
    recallDelta: 0.1,
    coverageDelta: 3,
    hasPrior: true,
  },
};

// Mirrors the BenchmarkRunRow shape returned by GET .../benchmark (`runs`).
const RUNS = [
  {
    id: "bench_latest",
    runAt: "2026-06-28T10:00:00.000Z",
    targets: 5,
    labeledTargets: 3,
    recall: 0.8,
    precision: 0.6,
    coverageClasses: 12,
    errored: 1,
    report: {},
    signals: [
      {
        kind: "coverage_gap",
        findingClass: "security:Reflected XSS in search",
        target: "juice-shop",
        detail: "Ground-truth class not detected on 1 labeled target (juice-shop). Build or fix a detector for this class.",
      },
      {
        kind: "noise_candidate",
        findingClass: "bug:Missing cache header",
        target: "webgoat",
        detail: "Reported 4 times across labeled targets but in NO ground truth. Candidate for precision tuning.",
      },
    ],
  },
  {
    id: "bench_prev",
    runAt: "2026-06-27T10:00:00.000Z",
    targets: 5,
    labeledTargets: 3,
    recall: 0.5,
    precision: 0.7,
    coverageClasses: 9,
    errored: 0,
    report: {},
    signals: [],
  },
];

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockPush.mockReset();
  mockUser = { id: "u-1", role: "admin" };
});

it("renders the latest-run summary cards from a runs payload", async () => {
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (isBenchmark(url)) return Promise.resolve(mkRes({ ok: true, runs: RUNS }));
    return Promise.resolve(mkRes({}));
  });
  render(<BenchmarkDashboardPage />);

  // recall 0.8 -> 80%, precision 0.6 -> 60%.
  expect(await screen.findByTestId("summary-recall")).toHaveTextContent("80%");
  expect(screen.getByTestId("summary-precision")).toHaveTextContent("60%");
  expect(screen.getByTestId("summary-coverage")).toHaveTextContent("12");
  expect(screen.getByTestId("summary-labeled")).toHaveTextContent("3");
  expect(screen.getByTestId("summary-labeled")).toHaveTextContent("of 5 scanned");
  expect(screen.getByTestId("summary-errored")).toHaveTextContent("1");
});

it("renders the learning-signal backlog grouped by kind with the real fields", async () => {
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (isBenchmark(url)) return Promise.resolve(mkRes({ ok: true, runs: RUNS }));
    return Promise.resolve(mkRes({}));
  });
  render(<BenchmarkDashboardPage />);

  // coverage_gap group: 1 signal, with findingClass + target + detail.
  const gapGroup = await screen.findByTestId("signal-group-coverage_gap");
  expect(screen.getByTestId("signal-count-coverage_gap")).toHaveTextContent("1");
  expect(within(gapGroup).getByTestId("signal-class-coverage_gap-0")).toHaveTextContent(
    "security:Reflected XSS in search",
  );
  expect(within(gapGroup).getByTestId("signal-target-coverage_gap-0")).toHaveTextContent("juice-shop");
  expect(within(gapGroup).getByTestId("signal-detail-coverage_gap-0")).toHaveTextContent(
    "Build or fix a detector",
  );

  // noise_candidate group: 1 signal.
  const noiseGroup = screen.getByTestId("signal-group-noise_candidate");
  expect(screen.getByTestId("signal-count-noise_candidate")).toHaveTextContent("1");
  expect(within(noiseGroup).getByTestId("signal-class-noise_candidate-0")).toHaveTextContent(
    "bug:Missing cache header",
  );
  expect(within(noiseGroup).getByTestId("signal-detail-noise_candidate-0")).toHaveTextContent(
    "precision tuning",
  );

  // The backlog total reflects the latest run's signal count.
  expect(screen.getByTestId("backlog-total")).toHaveTextContent("2 signals from the latest run");
});

it("renders a trend row per run, newest first", async () => {
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (isBenchmark(url)) return Promise.resolve(mkRes({ ok: true, runs: RUNS }));
    return Promise.resolve(mkRes({}));
  });
  render(<BenchmarkDashboardPage />);

  const latestRow = await screen.findByTestId("trend-row-bench_latest");
  expect(latestRow).toHaveTextContent("80%");
  expect(latestRow).toHaveTextContent("60%");
  const prevRow = screen.getByTestId("trend-row-bench_prev");
  expect(prevRow).toHaveTextContent("50%");
  expect(prevRow).toHaveTextContent("70%");
});

it("shows the explicit empty state when there are no runs (never blank)", async () => {
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (isBenchmark(url)) return Promise.resolve(mkRes({ ok: true, runs: [] }));
    return Promise.resolve(mkRes({}));
  });
  render(<BenchmarkDashboardPage />);

  expect(await screen.findByTestId("benchmark-empty")).toHaveTextContent("No benchmark runs yet");
  // No summary / backlog / trend when empty.
  expect(screen.queryByTestId("benchmark-summary")).not.toBeInTheDocument();
  expect(screen.queryByTestId("benchmark-backlog")).not.toBeInTheDocument();
});

it("shows an explicit backlog empty state when the latest run mined no signals", async () => {
  const cleanRun = [{ ...RUNS[0], id: "bench_clean", signals: [] }];
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (isBenchmark(url)) return Promise.resolve(mkRes({ ok: true, runs: cleanRun }));
    return Promise.resolve(mkRes({}));
  });
  render(<BenchmarkDashboardPage />);

  // Summary still renders, but the backlog shows its explicit empty state.
  expect(await screen.findByTestId("summary-recall")).toBeInTheDocument();
  expect(screen.getByTestId("backlog-empty")).toHaveTextContent("No learning signals in the latest run");
});

it("renders an error state on a failed fetch (never blank)", async () => {
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (isBenchmark(url)) return Promise.resolve(mkRes({ error: "boom" }, { ok: false, status: 500 }));
    return Promise.resolve(mkRes({}));
  });
  render(<BenchmarkDashboardPage />);

  expect(await screen.findByTestId("benchmark-error")).toHaveTextContent("HTTP 500");
});

it("redirects unauthenticated users to /login and does not fetch", async () => {
  mockUser = null;
  render(<BenchmarkDashboardPage />);

  await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/login?next=/admin/benchmark"));
  // The guard returns before any data fetch fires.
  expect(mockFetchWithRefresh).not.toHaveBeenCalled();
});

describe("Versus the competition section", () => {
  it("renders per-tool head-to-head bars + rival-only gap backlog from the competitive GET", async () => {
    mockFetchWithRefresh.mockImplementation((url: string) => {
      if (isBenchmark(url)) return Promise.resolve(mkRes({ ok: true, runs: RUNS }));
      if (isCompetitive(url)) return Promise.resolve(mkRes(COMPETITIVE));
      return Promise.resolve(mkRes({}));
    });
    render(<BenchmarkDashboardPage />);

    // The section + the first comparison row render with tool/target metadata.
    expect(await screen.findByTestId("competition-section")).toBeInTheDocument();
    const row = screen.getByTestId("competition-row-0");
    expect(row).toHaveAttribute("data-tool", "nuclei");
    expect(row).toHaveAttribute("data-target", "vampi");

    // Their recall (40%) is laid next to ours (60%).
    expect(screen.getByTestId("competition-theirs-recall-0")).toHaveTextContent("40%");
    expect(screen.getByTestId("competition-ours-recall-0")).toHaveTextContent("60%");

    // The rival-only gap (the backlog) is listed.
    expect(screen.getByTestId("competition-gap-0-0")).toHaveTextContent(
      "security:Broken object level authorization (IDOR)",
    );
  });

  it("renders the improvement tile with the recall sparkline + the latest delta", async () => {
    mockFetchWithRefresh.mockImplementation((url: string) => {
      if (isBenchmark(url)) return Promise.resolve(mkRes({ ok: true, runs: RUNS }));
      if (isCompetitive(url)) return Promise.resolve(mkRes(COMPETITIVE));
      return Promise.resolve(mkRes({}));
    });
    render(<BenchmarkDashboardPage />);

    expect(await screen.findByTestId("improvement-metric")).toHaveTextContent("60%");
    // The sparkline rendered with the 2-point series.
    expect(screen.getByTestId("improvement-sparkline")).toHaveAttribute("data-points", "2");
    // The latest delta (+10 pts) is shown.
    expect(screen.getByTestId("improvement-metric")).toHaveTextContent("+10 pts vs prior");
  });

  it("shows explicit empty states when there are no competitor runs (never blank)", async () => {
    mockFetchWithRefresh.mockImplementation((url: string) => {
      if (isBenchmark(url)) return Promise.resolve(mkRes({ ok: true, runs: RUNS }));
      // Competitive endpoint returns nothing yet.
      if (isCompetitive(url)) return Promise.resolve(mkRes({ ok: true, comparison: [], improvement: null }));
      return Promise.resolve(mkRes({}));
    });
    render(<BenchmarkDashboardPage />);

    expect(await screen.findByTestId("competition-section")).toBeInTheDocument();
    expect(screen.getByTestId("competition-empty")).toHaveTextContent(/no competitor benchmark runs yet/i);
    expect(screen.getByTestId("improvement-empty")).toHaveTextContent(/no recall trend yet/i);
  });

  it("degrades cleanly when the competitive endpoint errors (base dashboard intact)", async () => {
    mockFetchWithRefresh.mockImplementation((url: string) => {
      if (isBenchmark(url)) return Promise.resolve(mkRes({ ok: true, runs: RUNS }));
      if (isCompetitive(url)) return Promise.resolve(mkRes({ error: "boom" }, { ok: false, status: 500 }));
      return Promise.resolve(mkRes({}));
    });
    render(<BenchmarkDashboardPage />);

    // The base summary still renders (a competitive failure must not blank the page).
    expect(await screen.findByTestId("summary-recall")).toBeInTheDocument();
    // The competition section degrades to its empty states, never an error blank.
    expect(screen.getByTestId("competition-empty")).toBeInTheDocument();
  });
});
