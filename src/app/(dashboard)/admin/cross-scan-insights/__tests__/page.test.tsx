/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * UI tests for the cross-scan intelligence console
 * (/admin/cross-scan-insights).
 *
 * Asserts: the metric tiles render the insight count by kind; the insight feed
 * renders grouped by kind with severity pills + modalities + narrative + member
 * findings from a mocked GET; the explicit empty state shows for { insights: [] };
 * an error state shows on a non-ok fetch; the auth-redirect guard sends an
 * unauthenticated visitor to /login and does not fetch. fetchWithRefresh is mocked
 * + routed by URL; useRouter is mocked so the guard is exercised without nav.
 */

const mockFetchWithRefresh = jest.fn();
const mockPush = jest.fn();
let mockUser: unknown = { id: "u-1", role: "admin" };

jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
  getInstinctUser: () => mockUser,
  jsonHeaders: () => ({ "content-type": "application/json" }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

import { render, screen, waitFor, within } from "@testing-library/react";
import CrossScanInsightsPage from "@/app/(dashboard)/admin/cross-scan-insights/page";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkRes(body: unknown, opts: { ok?: boolean; status?: number } = {}): any {
  return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body };
}

const isInsights = (url: string) => url === "/api/admin/platform-scans/insights";

const INSIGHTS = [
  {
    id: "xins_compound",
    generatedAt: "2026-06-28T10:00:00.000Z",
    platform: "acme",
    kind: "compound_risk",
    severity: "critical",
    modalities: ["broken_journey", "security"],
    members: [
      { platform: "acme", route: "/checkout", severity: "high", category: "security", title: "Missing CSRF" },
      { platform: "acme", route: "/checkout", severity: "medium", category: "broken_journey", title: "Payment 500" },
    ],
    narrative: "Compound risk on /checkout (acme): two modalities chain.",
    status: "open",
    key: "k-compound",
  },
  {
    id: "xins_regression",
    generatedAt: "2026-06-28T09:00:00.000Z",
    platform: "acme",
    kind: "regression",
    severity: "high",
    modalities: ["security"],
    members: [{ platform: "acme", route: "/login", severity: "high", category: "security", title: "SQLi" }],
    narrative: "Regression on /login: SQLi reappeared 10 days after it was resolved.",
    status: "open",
    key: "k-regression",
  },
];

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockPush.mockReset();
  mockUser = { id: "u-1", role: "admin" };
});

it("renders the metric tiles with the insight count by kind", async () => {
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (isInsights(url)) return Promise.resolve(mkRes({ ok: true, insights: INSIGHTS }));
    return Promise.resolve(mkRes({}));
  });
  render(<CrossScanInsightsPage />);

  expect(await screen.findByTestId("metric-total")).toHaveTextContent("2");
  expect(screen.getByTestId("metric-compound_risk")).toHaveTextContent("1");
  expect(screen.getByTestId("metric-regression")).toHaveTextContent("1");
  expect(screen.getByTestId("metric-systemic_pattern")).toHaveTextContent("0");
  expect(screen.getByTestId("metric-coverage_blind_spot")).toHaveTextContent("0");
});

it("renders the insight feed grouped by kind with pills, modalities, narrative, members", async () => {
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (isInsights(url)) return Promise.resolve(mkRes({ ok: true, insights: INSIGHTS }));
    return Promise.resolve(mkRes({}));
  });
  render(<CrossScanInsightsPage />);

  const compoundGroup = await screen.findByTestId("insight-group-compound_risk");
  expect(screen.getByTestId("insight-count-compound_risk")).toHaveTextContent("1");

  const card = within(compoundGroup).getByTestId("insight-card-compound_risk-0");
  // Severity pill carries the elevated severity.
  expect(within(card).getByTestId("insight-severity-compound_risk-0")).toHaveAttribute("data-status", "critical");
  // Modalities chips render.
  expect(within(card).getByTestId("insight-modalities-compound_risk-0")).toHaveTextContent("security");
  // Narrative + member findings render.
  expect(within(card).getByTestId("insight-narrative-compound_risk-0")).toHaveTextContent("Compound risk on /checkout");
  const members = within(card).getByTestId("insight-members-compound_risk-0");
  expect(members).toHaveTextContent("/checkout");
  expect(members).toHaveTextContent("Missing CSRF");

  // Regression group renders its card too.
  expect(screen.getByTestId("insight-group-regression")).toBeInTheDocument();
  expect(screen.getByTestId("insight-count-regression")).toHaveTextContent("1");
});

it("shows the explicit empty state when there are no insights (never blank)", async () => {
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (isInsights(url)) return Promise.resolve(mkRes({ ok: true, insights: [] }));
    return Promise.resolve(mkRes({}));
  });
  render(<CrossScanInsightsPage />);

  expect(await screen.findByTestId("insights-empty")).toHaveTextContent("No cross-scan insights yet");
  expect(screen.queryByTestId("insights-feed")).not.toBeInTheDocument();
  expect(screen.queryByTestId("insights-metrics")).not.toBeInTheDocument();
});

it("renders an error state on a failed fetch (never blank)", async () => {
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (isInsights(url)) return Promise.resolve(mkRes({ error: "boom" }, { ok: false, status: 500 }));
    return Promise.resolve(mkRes({}));
  });
  render(<CrossScanInsightsPage />);

  expect(await screen.findByTestId("insights-error")).toHaveTextContent("HTTP 500");
});

it("redirects unauthenticated users to /login and does not fetch", async () => {
  mockUser = null;
  render(<CrossScanInsightsPage />);

  await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/login?next=/admin/cross-scan-insights"));
  expect(mockFetchWithRefresh).not.toHaveBeenCalled();
});
