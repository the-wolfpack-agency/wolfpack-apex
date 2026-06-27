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
import { render, screen, waitFor } from "@testing-library/react";

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
