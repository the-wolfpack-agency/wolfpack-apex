/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * /admin/feedback forwards ?includeTest=1 from its own URL to the API.
 *
 * The API hides automated E2E smoke notes from the human inbox unless
 * ?includeTest=1 is passed. The page used to drop that flag, so the
 * feedback screenshot E2E could never see its own row in the real UI.
 * Without the flag the inbox request is unchanged.
 */

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
}));

import { act, render, screen, waitFor } from "@testing-library/react";
import FeedbackPage from "@/app/(dashboard)/admin/feedback/page";

const smokeRow = {
  id: "fb-smoke-1",
  user_id: "u-1",
  user_email: "smoke-e2e@example.test",
  user_role: "cto",
  message: "E2E SCREENSHOT FLOW 1 abc",
  surface: "/assistant",
  user_agent: "Mozilla",
  workflow_id: null,
  created_at: new Date().toISOString(),
  resolved_at: null,
  resolved_by: null,
  resolution_note: null,
  has_screenshot: true,
};

function ok(body: unknown): any {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  window.history.replaceState({}, "", "/admin/feedback");
});

it("without the flag, requests the inbox exactly as before", async () => {
  mockFetchWithRefresh.mockResolvedValueOnce(ok({ count: 0, limit: 200, status: "open", feedback: [] }));
  await act(async () => {
    render(<FeedbackPage />);
  });
  await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalled());
  expect(mockFetchWithRefresh.mock.calls[0][0]).toBe("/api/admin/feedback?limit=200&status=open");
});

it("with ?includeTest=1, forwards the flag and renders the smoke row's thumbnail", async () => {
  window.history.replaceState({}, "", "/admin/feedback?includeTest=1");
  mockFetchWithRefresh.mockResolvedValueOnce(
    ok({ count: 1, limit: 200, status: "open", feedback: [smokeRow] }),
  );
  await act(async () => {
    render(<FeedbackPage />);
  });
  await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalled());
  expect(mockFetchWithRefresh.mock.calls[0][0]).toBe(
    "/api/admin/feedback?limit=200&status=open&includeTest=1",
  );
  await waitFor(() =>
    expect(screen.getByTestId(`admin-feedback-screenshot-${smokeRow.id}`)).toBeInTheDocument(),
  );
});
