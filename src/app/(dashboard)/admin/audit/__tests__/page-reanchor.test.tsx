/**
 * @jest-environment jsdom
 *
 * Admin audit-log page — one-click re-anchor control.
 *
 * Covers:
 *   - When verify returns { valid:false, brokenAt }, the page renders the
 *     "Acknowledge break (re-anchor)" control (data-testid="audit-reanchor")
 *     with a default reason pre-filled.
 *   - Clicking it POSTs { seq: brokenAt, reason } to
 *     /api/admin/audit-log/reanchor via fetchWithRefresh, then re-runs verify
 *     so the banner reflects the now-passing chain.
 *   - A valid chain does NOT render the re-anchor control.
 */

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...args: unknown[]) => mockFetchWithRefresh(...args),
  authHeaders: () => ({}),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
  getInstinctUser: () => ({ role: "cto" }),
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

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

async function renderPage() {
  const mod = await import("@/app/(dashboard)/admin/audit/page");
  const Page = mod.default;
  await act(async () => {
    render(<Page />);
  });
}

test("invalid verify result renders the re-anchor control with a default reason", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, init?: RequestInit) => {
    if (url.startsWith("/api/admin/audit-log/verify")) {
      return jsonResponse({ valid: false, brokenAt: 509, checkedCount: 800, reason: "hash mismatch" });
    }
    // initial entry load
    return jsonResponse({ entries: [] });
  });

  await renderPage();

  await act(async () => {
    fireEvent.click(screen.getByText("Verify integrity"));
  });

  await waitFor(() => {
    expect(screen.getByTestId("audit-reanchor")).toBeInTheDocument();
  });

  const reason = screen.getByTestId("audit-reanchor-reason") as HTMLInputElement;
  expect(reason.value).toBe("known concurrent-append fork, pre-advisory-lock");
  expect(screen.getByTestId("audit-reanchor")).toHaveTextContent("seq 509");
});

test("clicking re-anchor POSTs { seq: brokenAt, reason } then re-verifies", async () => {
  let verifyCalls = 0;
  mockFetchWithRefresh.mockImplementation((url: string, init?: RequestInit) => {
    if (url.startsWith("/api/admin/audit-log/verify")) {
      verifyCalls += 1;
      // First verify: broken. After re-anchor, verify reports a valid chain.
      return verifyCalls === 1
        ? jsonResponse({ valid: false, brokenAt: 509, checkedCount: 800, reason: "hash mismatch" })
        : jsonResponse({ valid: true, checkedCount: 800 });
    }
    if (url === "/api/admin/audit-log/reanchor") {
      return jsonResponse({ seq: 509, reason: "x", acknowledgedBy: "u_cto", alreadyAnchored: false });
    }
    return jsonResponse({ entries: [] });
  });

  await renderPage();

  await act(async () => {
    fireEvent.click(screen.getByText("Verify integrity"));
  });
  await waitFor(() => expect(screen.getByTestId("audit-reanchor")).toBeInTheDocument());

  await act(async () => {
    fireEvent.click(screen.getByTestId("audit-reanchor"));
  });

  // POST to /reanchor with the brokenAt seq + the default reason.
  await waitFor(() => {
    const call = mockFetchWithRefresh.mock.calls.find(
      ([u]) => u === "/api/admin/audit-log/reanchor",
    );
    expect(call).toBeTruthy();
    const init = call![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      seq: 509,
      reason: "known concurrent-append fork, pre-advisory-lock",
    });
  });

  // Re-verify ran and the banner now shows the valid chain.
  await waitFor(() => {
    expect(screen.getByText(/Chain valid/)).toBeInTheDocument();
  });
  expect(verifyCalls).toBe(2);
  // The re-anchor control is gone once the chain verifies.
  expect(screen.queryByTestId("audit-reanchor")).not.toBeInTheDocument();
});

test("a valid chain does not render the re-anchor control", async () => {
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (url.startsWith("/api/admin/audit-log/verify")) {
      return jsonResponse({ valid: true, checkedCount: 800 });
    }
    return jsonResponse({ entries: [] });
  });

  await renderPage();
  await act(async () => {
    fireEvent.click(screen.getByText("Verify integrity"));
  });

  await waitFor(() => expect(screen.getByText(/Chain valid/)).toBeInTheDocument());
  expect(screen.queryByTestId("audit-reanchor")).not.toBeInTheDocument();
});
