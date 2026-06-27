/**
 * @jest-environment jsdom
 *
 * Admin client-onboarding wizard.
 *
 * Covers:
 *   - Admin gate: a non-admin role renders the "CEO/CTO roles only" message and
 *     never GETs the targets list.
 *   - On mount the wizard GETs /api/admin/platform-scans/targets and renders a
 *     row per target, or the empty state when there are none.
 *   - Onboard (no repo) POSTs /api/admin/platform-scans/targets with a manifest
 *     whose static block is absent, then reveals the baseline section and
 *     reloads the list.
 *   - Onboard (with repo) POSTs a manifest whose static block carries the
 *     owner/repo.
 *   - Run baseline (with repo) POSTs profile, then the scan with mode "static",
 *     then recommendations, and renders the result line.
 *   - Run baseline (no repo) skips profile and POSTs the scan with mode "http".
 *   - Offboard DELETEs ?platform=<id> and reloads.
 *
 * The fetchWithRefresh mock is a single shared router (`routeFetch`) installed in
 * beforeEach. It keys on (url, method), decodes POST bodies from the call args,
 * and defaults every route to an ok response so unrelated steps never break.
 * Tests tune behaviour by mutating the `targetsBody`/`scanBody`/`recsBody`
 * fixtures, not by re-implementing the router.
 */

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockFetchWithRefresh = jest.fn();
const mockGetInstinctUser = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...args: unknown[]) => mockFetchWithRefresh(...args),
  authHeaders: () => ({}),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
  getInstinctUser: () => mockGetInstinctUser(),
}));

// Stable router reference — returning a fresh object each render would change
// the `[router]` dep of the page's mount effect and loop infinitely.
const stableRouter = { push: jest.fn() };
jest.mock("next/navigation", () => ({
  useRouter: () => stableRouter,
}));

beforeAll(() => {
  Object.defineProperty(window, "localStorage", {
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    writable: true,
  });
});

afterEach(() => {
  cleanup();
});

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
  return Promise.resolve({
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

const ACME_TARGET = {
  platform: "acme",
  baseUrl: "https://acme.app",
  hasStatic: true,
  hasApi: false,
  hasLogin: false,
};

// Shared, mutable fixtures the router reads. Tests tune these instead of
// re-implementing the router so every route answers uniformly.
let targetsBody: { targets: unknown[] } = { targets: [] };
let scanBody: { findingCount?: number; criticalCount?: number } = {};
let recsBody: { count?: number } = {};
let targetsGetCount = 0; // counts targets GETs (mount load + reloads)

// Single shared router. Order matters: match method-specific mutations first,
// then the GET surface.
function routeFetch(url: string, init?: RequestInit) {
  const method = init?.method ?? "GET";
  if (url.startsWith("/api/admin/platform-scans/targets") && method === "POST") {
    return jsonResponse({ ok: true });
  }
  if (url.startsWith("/api/admin/platform-scans/targets") && method === "DELETE") {
    return jsonResponse({ ok: true });
  }
  if (url === "/api/admin/platform-scans/profile" && method === "POST") {
    return jsonResponse({ ok: true });
  }
  if (url === "/api/admin/platform-scans" && method === "POST") {
    return jsonResponse(scanBody);
  }
  if (url === "/api/admin/platform-scans/recommendations" && method === "POST") {
    return jsonResponse(recsBody);
  }
  // GET /api/admin/platform-scans/targets (mount load + reload after mutations).
  if (url.startsWith("/api/admin/platform-scans/targets")) {
    targetsGetCount += 1;
    return jsonResponse(targetsBody);
  }
  return jsonResponse({ ok: true });
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockGetInstinctUser.mockReset();
  mockGetInstinctUser.mockReturnValue({ role: "cto" });
  targetsBody = { targets: [] };
  scanBody = {};
  recsBody = {};
  targetsGetCount = 0;
  mockFetchWithRefresh.mockImplementation((url: string, init?: RequestInit) => routeFetch(url, init));
});

async function renderPage() {
  const mod = await import("@/app/(dashboard)/admin/onboarding/page");
  const Page = mod.default;
  await act(async () => {
    render(<Page />);
  });
}

function postCall(url: string) {
  return mockFetchWithRefresh.mock.calls.find(
    ([u, i]) => u === url && (i as RequestInit)?.method === "POST",
  );
}

function postBody(url: string) {
  const call = postCall(url);
  return JSON.parse((call![1] as RequestInit).body as string);
}

test("non-admin role renders the roles-only message and never GETs targets", async () => {
  mockGetInstinctUser.mockReturnValue({ role: "ops" });

  await renderPage();

  await waitFor(() => {
    expect(screen.getByText(/CEO\/CTO roles only/i)).toBeInTheDocument();
  });
  expect(mockFetchWithRefresh).not.toHaveBeenCalled();
  expect(screen.queryByTestId("onboard-form")).not.toBeInTheDocument();
});

test("on mount it GETs targets and renders a row per target", async () => {
  targetsBody = { targets: [ACME_TARGET] };

  await renderPage();

  await waitFor(() => {
    expect(screen.getByTestId("onboard-target-row")).toBeInTheDocument();
  });

  const getCall = mockFetchWithRefresh.mock.calls.find(
    ([u, i]) =>
      (u as string).startsWith("/api/admin/platform-scans/targets") &&
      ((i as RequestInit)?.method ?? "GET") === "GET",
  );
  expect(getCall).toBeTruthy();

  const row = screen.getByTestId("onboard-target-row");
  expect(row).toHaveTextContent("acme");
  expect(row).toHaveTextContent("https://acme.app");
});

test("empty target list renders the empty state", async () => {
  targetsBody = { targets: [] };

  await renderPage();

  await waitFor(() => {
    expect(screen.getByTestId("onboard-empty")).toBeInTheDocument();
  });
  expect(screen.queryByTestId("onboard-target-row")).not.toBeInTheDocument();
});

test("onboard (no repo) POSTs a manifest without static, reveals baseline, reloads", async () => {
  targetsBody = { targets: [] };

  await renderPage();

  await waitFor(() => expect(screen.getByTestId("onboard-empty")).toBeInTheDocument());
  expect(targetsGetCount).toBe(1);

  fireEvent.change(screen.getByTestId("onboard-platform"), { target: { value: "acme" } });
  fireEvent.change(screen.getByTestId("onboard-baseurl"), { target: { value: "https://acme.app" } });

  await act(async () => {
    fireEvent.submit(screen.getByTestId("onboard-form"));
  });

  await waitFor(() => expect(postCall("/api/admin/platform-scans/targets")).toBeTruthy());

  const body = postBody("/api/admin/platform-scans/targets");
  expect(body.platform).toBe("acme");
  expect(body.manifest.baseUrl).toBe("https://acme.app");
  expect(body.manifest.static).toBeUndefined();

  // The baseline section appears and the list reloaded.
  await waitFor(() => expect(screen.getByTestId("onboard-baseline")).toBeInTheDocument());
  await waitFor(() => expect(targetsGetCount).toBe(2));
});

test("onboard (with repo) POSTs a manifest whose static block carries owner/repo", async () => {
  targetsBody = { targets: [] };

  await renderPage();

  await waitFor(() => expect(screen.getByTestId("onboard-empty")).toBeInTheDocument());

  fireEvent.change(screen.getByTestId("onboard-platform"), { target: { value: "acme" } });
  fireEvent.change(screen.getByTestId("onboard-baseurl"), { target: { value: "https://acme.app" } });
  fireEvent.change(screen.getByTestId("onboard-repo-owner"), { target: { value: "acme-co" } });
  fireEvent.change(screen.getByTestId("onboard-repo-name"), { target: { value: "acme-web" } });

  await act(async () => {
    fireEvent.submit(screen.getByTestId("onboard-form"));
  });

  await waitFor(() => expect(postCall("/api/admin/platform-scans/targets")).toBeTruthy());

  const body = postBody("/api/admin/platform-scans/targets");
  expect(body.manifest.static).toBeDefined();
  expect(body.manifest.static.owner).toBe("acme-co");
  expect(body.manifest.static.repo).toBe("acme-web");
});

test("run baseline (with repo) POSTs profile then scan mode static then recommendations, renders result", async () => {
  targetsBody = { targets: [] };
  scanBody = { findingCount: 3, criticalCount: 1 };
  recsBody = { count: 5 };

  await renderPage();

  await waitFor(() => expect(screen.getByTestId("onboard-empty")).toBeInTheDocument());

  fireEvent.change(screen.getByTestId("onboard-platform"), { target: { value: "acme" } });
  fireEvent.change(screen.getByTestId("onboard-baseurl"), { target: { value: "https://acme.app" } });
  fireEvent.change(screen.getByTestId("onboard-repo-owner"), { target: { value: "acme-co" } });
  fireEvent.change(screen.getByTestId("onboard-repo-name"), { target: { value: "acme-web" } });

  await act(async () => {
    fireEvent.submit(screen.getByTestId("onboard-form"));
  });

  await waitFor(() => expect(screen.getByTestId("onboard-run-baseline")).toBeInTheDocument());

  await act(async () => {
    fireEvent.click(screen.getByTestId("onboard-run-baseline"));
  });

  await waitFor(() => expect(postCall("/api/admin/platform-scans/profile")).toBeTruthy());
  expect(postCall("/api/admin/platform-scans")).toBeTruthy();
  expect(postBody("/api/admin/platform-scans").mode).toBe("static");
  expect(postCall("/api/admin/platform-scans/recommendations")).toBeTruthy();

  const result = await screen.findByTestId("onboard-baseline-result");
  expect(result).toHaveTextContent("3 findings");
  expect(result).toHaveTextContent("1 critical");
  expect(result).toHaveTextContent("5 recommendations");
});

test("run baseline (no repo) skips profile and POSTs scan mode http", async () => {
  targetsBody = { targets: [] };
  scanBody = { findingCount: 0, criticalCount: 0 };
  recsBody = { count: 0 };

  await renderPage();

  await waitFor(() => expect(screen.getByTestId("onboard-empty")).toBeInTheDocument());

  fireEvent.change(screen.getByTestId("onboard-platform"), { target: { value: "acme" } });
  fireEvent.change(screen.getByTestId("onboard-baseurl"), { target: { value: "https://acme.app" } });

  await act(async () => {
    fireEvent.submit(screen.getByTestId("onboard-form"));
  });

  await waitFor(() => expect(screen.getByTestId("onboard-run-baseline")).toBeInTheDocument());

  await act(async () => {
    fireEvent.click(screen.getByTestId("onboard-run-baseline"));
  });

  await waitFor(() => expect(postCall("/api/admin/platform-scans")).toBeTruthy());
  expect(postCall("/api/admin/platform-scans/profile")).toBeFalsy();
  expect(postBody("/api/admin/platform-scans").mode).toBe("http");

  await screen.findByTestId("onboard-baseline-result");
});

test("offboard DELETEs ?platform=acme and reloads the list", async () => {
  targetsBody = { targets: [ACME_TARGET] };

  await renderPage();

  await waitFor(() => expect(screen.getByTestId("onboard-offboard")).toBeInTheDocument());
  expect(targetsGetCount).toBe(1);

  await act(async () => {
    fireEvent.click(screen.getByTestId("onboard-offboard"));
  });

  await waitFor(() => {
    const del = mockFetchWithRefresh.mock.calls.find(
      ([u, i]) =>
        u === "/api/admin/platform-scans/targets?platform=acme" &&
        (i as RequestInit)?.method === "DELETE",
    );
    expect(del).toBeTruthy();
  });

  await waitFor(() => expect(targetsGetCount).toBe(2));
});
