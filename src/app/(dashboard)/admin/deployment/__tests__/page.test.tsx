/**
 * @jest-environment jsdom
 *
 * UI tests for /admin/deployment (deployment readiness gate).
 * Asserts: unauthenticated -> redirect to /login (no blank state); a ready
 * result renders the green "Ready to deploy" banner; a not-ready result renders
 * the red "Not ready" banner with the critical-failure count and splits critical
 * vs advisory check rows with the right status labels; a fetch error surfaces an
 * error banner. fetchWithRefresh + getInstinctUser are mocked.
 */

import "@testing-library/jest-dom";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";

const mockGetUser = jest.fn();
const mockFetch = jest.fn();
const mockPush = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
jest.mock("@/lib/client-auth", () => ({
  getInstinctUser: () => mockGetUser(),
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import DeploymentReadinessPage from "@/app/(dashboard)/admin/deployment/page";

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const errRes = (status = 500) =>
  ({ ok: false, status, json: async () => ({}) }) as unknown as Response;

const READY = {
  ok: true,
  checks: [
    { name: "env:DATABASE_URL", pass: true, detail: "DATABASE_URL is set.", critical: true },
    { name: "connect:postgres", pass: true, detail: "Postgres answered SELECT 1.", critical: true },
    { name: "connect:qdrant", pass: true, detail: "Qdrant health check passed.", critical: false },
  ],
};

const NOT_READY = {
  ok: false,
  checks: [
    { name: "env:DATABASE_URL", pass: true, detail: "DATABASE_URL is set.", critical: true },
    { name: "connect:postgres", pass: false, detail: "Postgres unreachable: connection refused", critical: true },
    { name: "connect:qdrant", pass: false, detail: "Qdrant did not respond OK.", critical: false },
  ],
};

beforeEach(() => {
  mockGetUser.mockReset();
  mockFetch.mockReset();
  mockPush.mockReset();
});

describe("DeploymentReadinessPage", () => {
  test("redirects to /login when unauthenticated (no blank state)", () => {
    mockGetUser.mockReturnValue(null);
    render(<DeploymentReadinessPage />);
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining("/login"));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("renders the green Ready banner + critical and advisory check rows", async () => {
    mockGetUser.mockReturnValue({ role: "admin" });
    mockFetch.mockResolvedValue(okJson(READY));
    render(<DeploymentReadinessPage />);

    const banner = await screen.findByTestId("readiness-banner");
    expect(banner).toHaveAttribute("data-ready", "true");
    expect(banner).toHaveTextContent(/Ready to deploy/i);

    // Critical rows live in the critical section, advisory in the advisory section.
    expect(screen.getByTestId("check-row-connect:postgres")).toBeInTheDocument();
    expect(screen.getByTestId("check-row-connect:qdrant")).toBeInTheDocument();
    // A passing check shows the "Ready" status.
    expect(screen.getByTestId("check-status-connect:postgres")).toHaveTextContent("Ready");
  });

  test("renders the red Not ready banner with the critical-failure count + status labels", async () => {
    mockGetUser.mockReturnValue({ role: "admin" });
    mockFetch.mockResolvedValue(okJson(NOT_READY));
    render(<DeploymentReadinessPage />);

    const banner = await screen.findByTestId("readiness-banner");
    expect(banner).toHaveAttribute("data-ready", "false");
    expect(banner).toHaveTextContent(/Not ready/i);
    expect(banner).toHaveTextContent(/1 critical check/i);
    // Advisory failure noted separately as degraded-not-blocking.
    expect(screen.getByTestId("advisory-note")).toHaveTextContent(/1 advisory check/i);

    // A failing critical check shows "Not ready"; a failing advisory shows "Advisory".
    expect(screen.getByTestId("check-status-connect:postgres")).toHaveTextContent("Not ready");
    expect(screen.getByTestId("check-status-connect:qdrant")).toHaveTextContent("Advisory");
  });

  test("surfaces an error banner when the readiness endpoint fails", async () => {
    mockGetUser.mockReturnValue({ role: "admin" });
    mockFetch.mockResolvedValue(errRes(500));
    render(<DeploymentReadinessPage />);
    await waitFor(() => {
      expect(screen.getByTestId("readiness-error")).toHaveTextContent(/HTTP 500/);
    });
    expect(screen.queryByTestId("readiness-banner")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Production release gate section
// ---------------------------------------------------------------------------

/**
 * Route fetches by URL so the readiness fetch and the release-gate fetch can be
 * stubbed independently (the page fires both on mount). `gate` is the
 * ReleaseGateStatus the GET endpoint wraps as { ok, gate }.
 */
function routeFetch(opts: {
  readiness?: unknown;
  readinessStatus?: number;
  gate?: unknown;
  plan?: unknown;
  promote?: (body: unknown) => Response;
}) {
  return (url: string, init?: { method?: string; body?: string }) => {
    if (url.includes("/release-gate/promote")) {
      const body = init?.body ? JSON.parse(init.body) : {};
      return Promise.resolve(opts.promote ? opts.promote(body) : okJson({ ok: true, mergedSha: "abc123" }));
    }
    if (url.includes("/release-gate")) {
      return Promise.resolve(okJson({ ok: true, gate: opts.gate, plan: opts.plan ?? null }));
    }
    // readiness
    if (opts.readinessStatus && opts.readinessStatus >= 400) {
      return Promise.resolve(errRes(opts.readinessStatus));
    }
    return Promise.resolve(okJson(opts.readiness ?? READY));
  };
}

const change = (over: Partial<Record<string, unknown>> = {}) => ({
  number: 42,
  title: "Add release gate",
  url: "https://github.com/the-wolfpack-agency/wolfpack-apex/pull/42",
  author: "octocat",
  headSha: "deadbeef",
  state: "awaiting_approval",
  reason: "Waiting on your approval",
  ageHours: 3.2,
  ...over,
});

describe("ReleaseGateSection", () => {
  test("renders blocking rows with the correct pill tone, reason, and age", async () => {
    mockGetUser.mockReturnValue({ role: "admin" });
    mockFetch.mockImplementation(
      routeFetch({
        gate: {
          productionBranch: "main",
          checkedAt: new Date().toISOString(),
          blocking: [
            change({ number: 7, state: "checks_failing", reason: "Tests are failing - fix needed", ageHours: 5.0 }),
            change({ number: 8, state: "checks_running", reason: "Tests are still running", ageHours: 0.5 }),
          ],
        },
      }),
    );
    render(<DeploymentReadinessPage />);

    const row7 = await screen.findByTestId("blocking-row-7");
    expect(within(row7).getByTestId("blocking-pill-7")).toHaveAttribute("data-tone", "error");
    expect(within(row7).getByTestId("blocking-reason-7")).toHaveTextContent("Tests are failing - fix needed");
    expect(within(row7).getByTestId("blocking-age-7")).toHaveTextContent("blocking for 5.0h");

    const row8 = await screen.findByTestId("blocking-row-8");
    expect(within(row8).getByTestId("blocking-pill-8")).toHaveAttribute("data-tone", "info");

    // No false all-clear and no promote on a non-ready change.
    expect(screen.queryByTestId("release-gate-empty")).not.toBeInTheDocument();
    expect(screen.queryByTestId("promote-7")).not.toBeInTheDocument();
  });

  test("ready_to_merge shows Promote, and confirming it POSTs promote + shows success", async () => {
    mockGetUser.mockReturnValue({ role: "admin" });
    const promote = jest.fn((body: unknown) => okJson({ ok: true, mergedSha: "sha-merged" }));
    mockFetch.mockImplementation(
      routeFetch({
        gate: {
          productionBranch: "main",
          checkedAt: new Date().toISOString(),
          blocking: [change({ number: 9, state: "ready_to_merge", reason: "Ready to promote", ageHours: 1.0 })],
        },
        promote,
      }),
    );
    render(<DeploymentReadinessPage />);

    const promoteBtn = await screen.findByTestId("promote-9");
    expect(within(await screen.findByTestId("blocking-row-9")).getByTestId("blocking-pill-9")).toHaveAttribute(
      "data-tone",
      "success",
    );

    // Confirm step before any POST.
    fireEvent.click(promoteBtn);
    const confirm = await screen.findByTestId("promote-confirm-9");
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(screen.getByTestId("promote-result-9")).toHaveTextContent(/Promoted - deploying now/i);
    });
    expect(promote).toHaveBeenCalledWith({ prNumber: 9 });
  });

  test("a failed promote surfaces the typed reason (fail closed, no false success)", async () => {
    mockGetUser.mockReturnValue({ role: "admin" });
    mockFetch.mockImplementation(
      routeFetch({
        gate: {
          productionBranch: "main",
          checkedAt: new Date().toISOString(),
          blocking: [change({ number: 11, state: "ready_to_merge", reason: "Ready to promote", ageHours: 1.0 })],
        },
        promote: () =>
          ({ ok: false, status: 400, json: async () => ({ ok: false, reason: "Not ready to promote: Has merge conflicts." }) }) as unknown as Response,
      }),
    );
    render(<DeploymentReadinessPage />);

    fireEvent.click(await screen.findByTestId("promote-11"));
    fireEvent.click(await screen.findByTestId("promote-confirm-11"));
    await waitFor(() => {
      expect(screen.getByTestId("promote-result-11")).toHaveTextContent(/Has merge conflicts/i);
    });
  });

  test("degraded gate shows the warning, NOT a false all-clear", async () => {
    mockGetUser.mockReturnValue({ role: "admin" });
    mockFetch.mockImplementation(
      routeFetch({
        gate: {
          productionBranch: "main",
          checkedAt: new Date().toISOString(),
          blocking: [],
          degraded: { detail: "Could not reach GitHub to check the release gate: timeout" },
        },
      }),
    );
    render(<DeploymentReadinessPage />);

    const warn = await screen.findByTestId("release-gate-degraded");
    expect(warn).toHaveTextContent(/status unknown/i);
    expect(screen.queryByTestId("release-gate-empty")).not.toBeInTheDocument();
  });

  test("empty gate shows the explicit all-live empty state", async () => {
    mockGetUser.mockReturnValue({ role: "admin" });
    mockFetch.mockImplementation(
      routeFetch({
        gate: { productionBranch: "main", checkedAt: new Date().toISOString(), blocking: [] },
      }),
    );
    render(<DeploymentReadinessPage />);

    expect(await screen.findByTestId("release-gate-empty")).toHaveTextContent(/All changes are live in production/i);
  });

  test("renders the recommended approval order with per-step rebase notes", async () => {
    mockGetUser.mockReturnValue({ role: "admin" });
    mockFetch.mockImplementation(
      routeFetch({
        gate: {
          productionBranch: "main",
          checkedAt: new Date().toISOString(),
          blocking: [
            change({ number: 10, state: "ready_to_merge", reason: "Ready to promote", ageHours: 5 }),
            change({ number: 11, state: "ready_to_merge", reason: "Ready to promote", ageHours: 1 }),
          ],
        },
        plan: {
          readyCount: 2,
          independentCount: 0,
          hasOverlaps: true,
          steps: [
            { number: 10, title: "First", url: "u10", reason: "Ready to promote", ready: true, order: 1, independent: false, rebaseAfter: [], sharedFiles: [], note: "Promote first of its overlapping group - it merges clean; the others rebase onto it." },
            { number: 11, title: "Second", url: "u11", reason: "Ready to promote", ready: true, order: 2, independent: false, rebaseAfter: [10], sharedFiles: ["src/lib/analytics.ts"], note: "Promote after #10, then a one-line union rebase on append-only files (analytics.ts)." },
          ],
        },
      }),
    );
    render(<DeploymentReadinessPage />);

    expect(await screen.findByTestId("merge-plan")).toBeInTheDocument();
    // Ordered steps in the recommended sequence.
    const steps = screen.getAllByTestId(/^merge-step-\d+$/);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toHaveAttribute("data-order", "1");
    expect(steps[1]).toHaveAttribute("data-order", "2");
    // The second step tells the operator to rebase after the first, on a hot file.
    expect(screen.getByTestId("merge-step-note-11")).toHaveTextContent(/after #10/i);
    expect(screen.getByTestId("merge-step-note-11")).toHaveTextContent(/union/i);
  });

  test("merge plan flags an all-independent set as safe in any order", async () => {
    mockGetUser.mockReturnValue({ role: "admin" });
    mockFetch.mockImplementation(
      routeFetch({
        gate: {
          productionBranch: "main",
          checkedAt: new Date().toISOString(),
          blocking: [change({ number: 20, state: "ready_to_merge", reason: "Ready to promote", ageHours: 2 })],
        },
        plan: {
          readyCount: 1,
          independentCount: 1,
          hasOverlaps: false,
          steps: [
            { number: 20, title: "Solo", url: "u20", reason: "Ready to promote", ready: true, order: 1, independent: true, rebaseAfter: [], sharedFiles: [], note: "Independent - touches no files another open change touches. Safe to promote in any order." },
          ],
        },
      }),
    );
    render(<DeploymentReadinessPage />);

    expect(await screen.findByTestId("merge-plan-independent")).toHaveTextContent(/any order/i);
  });
});
