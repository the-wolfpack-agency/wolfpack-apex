/**
 * @jest-environment jsdom
 *
 * Client-offboarding console (/admin/offboarding).
 *
 * Covers:
 *   - Unauthenticated: redirects to /login (no blank authed shell).
 *   - The destructive purge is CONFIRM-GATED: the purge button is disabled until
 *     the confirmation field exactly matches the typed workspace id, and a
 *     mismatch surfaces an inline error.
 *   - A successful purge renders the per-table result counts + the total.
 *   - Secondary-store residue renders as a retry warning.
 *   - An error response renders the error state.
 *
 * fetchWithRefresh + getInstinctUser + useRouter are mocked so no network / auth
 * infra is touched.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockFetchWithRefresh = jest.fn();
const mockGetInstinctUser = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...args: unknown[]) => mockFetchWithRefresh(...args),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
  getInstinctUser: () => mockGetInstinctUser(),
}));

const stableRouter = { push: jest.fn() };
jest.mock("next/navigation", () => ({ useRouter: () => stableRouter }));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

import OffboardingPage from "@/app/(dashboard)/admin/offboarding/page";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkRes(body: unknown, opts: { ok?: boolean; status?: number } = {}): any {
  return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body };
}

const RESULT = {
  ok: true,
  workspaceId: "acme-crm",
  counts: {
    instinct_platform_scan_findings: 12,
    instinct_platform_scans: 3,
    instinct_scan_targets: 1,
    instinct_target_verifications: 1,
    instinct_system_profiles: 1,
    instinct_automation_recommendations: 2,
    instinct_pentest_authorizations: 0,
    instinct_connector_credentials: 2,
  },
  residue: {},
  totalDeleted: 22,
  secondaryStoresClean: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  stableRouter.push.mockReset();
  mockGetInstinctUser.mockReturnValue({ role: "cto" });
});
afterEach(cleanup);

describe("OffboardingPage", () => {
  it("redirects to /login when unauthenticated", () => {
    mockGetInstinctUser.mockReturnValue(null);
    render(<OffboardingPage />);
    expect(stableRouter.push).toHaveBeenCalledWith("/login?next=/admin/offboarding");
  });

  it("lists what will be purged and keeps the purge button disabled until confirm matches", () => {
    render(<OffboardingPage />);
    // The purge surface is shown (no blank state) with the table list.
    expect(screen.getByTestId("purge-table-list")).toBeInTheDocument();
    expect(screen.getByTestId("purge-table-instinct_connector_credentials")).toBeInTheDocument();

    const button = screen.getByTestId("purge-button") as HTMLButtonElement;
    expect(button).toBeDisabled();

    // Type a workspace id but a non-matching confirmation -> still disabled + error.
    fireEvent.change(screen.getByTestId("workspace-id-input"), { target: { value: "acme-crm" } });
    fireEvent.change(screen.getByTestId("confirm-input"), { target: { value: "wrong" } });
    expect(button).toBeDisabled();
    expect(screen.getByTestId("confirm-mismatch")).toBeInTheDocument();

    // Matching confirmation enables it.
    fireEvent.change(screen.getByTestId("confirm-input"), { target: { value: "acme-crm" } });
    expect(button).toBeEnabled();
    expect(screen.queryByTestId("confirm-mismatch")).not.toBeInTheDocument();
  });

  it("POSTs the purge and renders the result counts", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkRes(RESULT));
    render(<OffboardingPage />);

    fireEvent.change(screen.getByTestId("workspace-id-input"), { target: { value: "acme-crm" } });
    fireEvent.change(screen.getByTestId("confirm-input"), { target: { value: "acme-crm" } });
    fireEvent.click(screen.getByTestId("purge-button"));

    await waitFor(() => expect(screen.getByTestId("offboard-result")).toBeInTheDocument());

    // Posted the confirmed body to the offboard endpoint.
    const [url, init] = mockFetchWithRefresh.mock.calls[0];
    expect(url).toBe("/api/admin/platform-scans/offboard");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ workspaceId: "acme-crm", confirm: "acme-crm" });

    expect(screen.getByTestId("result-total")).toHaveTextContent("22 rows purged");
    expect(screen.getByTestId("result-count-instinct_platform_scan_findings")).toHaveTextContent("12");
    expect(screen.getByTestId("result-residue-clean")).toBeInTheDocument();
  });

  it("renders residue as a retry warning when a secondary store is down", async () => {
    mockFetchWithRefresh.mockResolvedValue(
      mkRes({ ...RESULT, residue: { qdrant: "unreachable" }, secondaryStoresClean: false }),
    );
    render(<OffboardingPage />);
    fireEvent.change(screen.getByTestId("workspace-id-input"), { target: { value: "acme-crm" } });
    fireEvent.change(screen.getByTestId("confirm-input"), { target: { value: "acme-crm" } });
    fireEvent.click(screen.getByTestId("purge-button"));

    await waitFor(() => expect(screen.getByTestId("result-residue")).toBeInTheDocument());
    expect(screen.getByTestId("result-residue")).toHaveTextContent("qdrant");
  });

  it("renders the error state when the purge fails", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkRes({ error: "confirmation_required" }, { ok: false, status: 400 }));
    render(<OffboardingPage />);
    fireEvent.change(screen.getByTestId("workspace-id-input"), { target: { value: "acme-crm" } });
    fireEvent.change(screen.getByTestId("confirm-input"), { target: { value: "acme-crm" } });
    fireEvent.click(screen.getByTestId("purge-button"));

    await waitFor(() => expect(screen.getByTestId("offboard-error")).toBeInTheDocument());
  });
});
