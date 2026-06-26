/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * UI tests for the platform-scan review surface (/admin/platform-scans).
 * Asserts: findings render with title + severity + route from a mocked GET;
 * "Run scan" POSTs to /api/admin/platform-scans then the list reflects the
 * refetched findings; Acknowledge POSTs {status:"acknowledged"} to the
 * findings/{id} endpoint and drops the row in place; the empty state shows
 * when GET returns no findings. fetchWithRefresh is mocked + routed by
 * URL/method so list vs scan vs decide calls are asserted independently.
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

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import PlatformScansPage from "@/app/(dashboard)/admin/platform-scans/page";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkRes(body: unknown, opts: { ok?: boolean; status?: number } = {}): any {
  return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body };
}

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

beforeEach(() => mockFetchWithRefresh.mockReset());

it("renders findings with title, severity, and route from the GET", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (url === "/api/admin/platform-scans" && !opts) return Promise.resolve(mkRes({ findings: [mkFinding()] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);

  expect(await screen.findByTestId("finding-row-f-1")).toBeInTheDocument();
  expect(screen.getByTestId("finding-row-f-1")).toHaveTextContent("Checkout returns 500 after coupon apply");
  expect(screen.getByTestId("finding-severity-f-1")).toHaveTextContent("critical");
  expect(screen.getByTestId("finding-route-f-1")).toHaveTextContent("/inventory/checkout");
});

it("Run scan POSTs to /api/admin/platform-scans and the list reflects the refetch", async () => {
  const before = mkFinding({ id: "f-1", title: "Old finding" });
  const after = mkFinding({ id: "f-2", title: "Fresh finding after scan", route: "/login" });
  let scanned = false;

  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (url === "/api/admin/platform-scans" && opts?.method === "POST") {
      scanned = true;
      return Promise.resolve(mkRes({ ok: true, scanId: "scan-2", findingCount: 1, criticalCount: 1, findings: [after] }));
    }
    if (url === "/api/admin/platform-scans" && !opts) {
      return Promise.resolve(mkRes({ findings: scanned ? [after] : [before] }));
    }
    return Promise.resolve(mkRes({}));
  });

  render(<PlatformScansPage />);
  await screen.findByTestId("finding-row-f-1");

  fireEvent.click(screen.getByTestId("run-scan"));

  expect(await screen.findByTestId("finding-row-f-2")).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByTestId("finding-row-f-1")).not.toBeInTheDocument());
  expect(screen.getByTestId("scan-summary")).toHaveTextContent("1 finding, 1 critical");

  const post = mockFetchWithRefresh.mock.calls.find((c) => c[0] === "/api/admin/platform-scans" && c[1]?.method === "POST");
  expect(JSON.parse(String(post![1].body))).toEqual({ platform: "wolfpack-auto" });
});

it("Acknowledge POSTs {status:'acknowledged'} to findings/{id} and drops the row", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (url === "/api/admin/platform-scans" && !opts) return Promise.resolve(mkRes({ findings: [mkFinding()] }));
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
    if (url === "/api/admin/platform-scans" && !opts) return Promise.resolve(mkRes({ findings: [] }));
    return Promise.resolve(mkRes({}));
  });
  render(<PlatformScansPage />);
  expect(await screen.findByTestId("findings-empty")).toBeInTheDocument();
});
