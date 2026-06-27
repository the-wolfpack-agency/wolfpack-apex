/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * UI tests for the GitHub App connector page (/admin/connectors/github-app).
 * Asserts the three states render without a blank: linked (scoped installation
 * token badge + installation row), not-linked-but-configured (PAT fallback
 * badge + "no installation"), and not-configured (App-not-configured + still a
 * usable fallback badge). Also asserts the manual link form POSTs the numeric
 * installation id. fetchWithRefresh + next/navigation are mocked.
 */

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

jest.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: () => null }),
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => "/admin/connectors/github-app",
}));

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import GithubAppConnectorPage from "@/app/(dashboard)/admin/connectors/github-app/page";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkRes(body: unknown, opts: { ok?: boolean; status?: number } = {}): any {
  return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body };
}

function statusRoute(status: unknown) {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (url === "/api/admin/connectors/github-app" && opts?.method === "POST") {
      return Promise.resolve(mkRes({ installation: { installationId: "42" } }));
    }
    return Promise.resolve(mkRes(status));
  });
}

beforeEach(() => mockFetchWithRefresh.mockReset());

it("renders the linked state with a scoped-installation-token badge", async () => {
  statusRoute({
    configured: true,
    patConfigured: true,
    installation: {
      workspaceId: "default",
      installationId: "42",
      accountLogin: "acme",
      linkedAt: new Date().toISOString(),
      linkedBy: "u1",
    },
    fallback: "installation",
  });
  render(<GithubAppConnectorPage />);
  await waitFor(() => expect(screen.getByTestId("ga-installation")).toBeInTheDocument());
  expect(screen.getByTestId("ga-configured")).toHaveTextContent("yes");
  expect(screen.getByTestId("fallback-badge")).toHaveTextContent("Scoped installation token");
});

it("renders the not-linked-but-configured state with the PAT fallback badge", async () => {
  statusRoute({
    configured: true,
    patConfigured: true,
    installation: null,
    fallback: "pat",
  });
  render(<GithubAppConnectorPage />);
  await waitFor(() => expect(screen.getByTestId("ga-no-installation")).toBeInTheDocument());
  expect(screen.getByTestId("fallback-badge")).toHaveTextContent("Falling back to shared PAT");
});

it("renders the not-configured state (no App env) without a blank screen", async () => {
  statusRoute({
    configured: false,
    patConfigured: true,
    installation: null,
    fallback: "pat",
  });
  render(<GithubAppConnectorPage />);
  await waitFor(() => expect(screen.getByTestId("ga-configured")).toHaveTextContent("no"));
  expect(screen.getByTestId("fallback-badge")).toBeInTheDocument();
});

it("manual link form POSTs the numeric installation id", async () => {
  statusRoute({
    configured: true,
    patConfigured: true,
    installation: null,
    fallback: "pat",
  });
  render(<GithubAppConnectorPage />);
  await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalled());

  fireEvent.change(screen.getByTestId("ga-installation-id"), {
    target: { value: "12345678" },
  });
  fireEvent.click(screen.getByTestId("ga-submit"));

  await waitFor(() => {
    const post = mockFetchWithRefresh.mock.calls.find(
      (c) => c[0] === "/api/admin/connectors/github-app" && c[1]?.method === "POST",
    );
    expect(post).toBeTruthy();
    expect(JSON.parse(post![1].body)).toEqual({ installationId: "12345678" });
  });
});
