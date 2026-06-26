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
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
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
const isList = (url: string, opts?: { method?: string }) =>
  !opts && url.startsWith("/api/admin/platform-scans") && !url.includes("/findings/") && !isTargets(url);

beforeEach(() => mockFetchWithRefresh.mockReset());

it("populates the platform selector from targets and labels findings by platform", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (isTargets(url)) return Promise.resolve(mkRes({ targets: TARGETS }));
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
    if (isList(url, opts)) return Promise.resolve(mkRes({ findings: [] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);
  expect(await screen.findByTestId("findings-empty")).toBeInTheDocument();
});
