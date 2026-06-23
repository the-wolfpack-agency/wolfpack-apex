/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * Comment-on-resolve flow for /admin/feedback.
 *
 * Shipped 2026-05-20 after CTO asked: "there should be a way for me to
 * comment on the feedback to resolve it." The backend route has always
 * accepted an optional `note` on PATCH — this test guards that the UI
 * actually collects it and sends it on submit.
 */

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
}));

import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import FeedbackPage from "@/app/(dashboard)/admin/feedback/page";

function mkRes(body: unknown, opts: { ok?: boolean; status?: number } = {}): any {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => body,
  };
}

const sampleRow = {
  id: "fb-1234567890",
  user_id: "u-1",
  user_email: "homyk@thewolfpack.agency",
  user_role: "cto",
  message: "Job Codes page is blank.",
  surface: "/job-codes",
  user_agent: "Mozilla",
  workflow_id: null,
  created_at: new Date().toISOString(),
  resolved_at: null,
  resolved_by: null,
  resolution_note: null,
};

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

describe("/admin/feedback — comment + resolve", () => {
  it("renders an Add Note button on open feedback rows", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(
      mkRes({ workspace_id: "w", count: 1, limit: 200, status: "open", feedback: [sampleRow] }),
    );
    await act(async () => {
      render(<FeedbackPage />);
    });
    await waitFor(() =>
      expect(screen.getByTestId(`admin-feedback-add-note-${sampleRow.id}`)).toBeInTheDocument(),
    );
  });

  it("clicking Comment+resolve opens the note textarea", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(
      mkRes({ workspace_id: "w", count: 1, limit: 200, status: "open", feedback: [sampleRow] }),
    );
    await act(async () => {
      render(<FeedbackPage />);
    });
    await waitFor(() =>
      expect(screen.getByTestId(`admin-feedback-add-note-${sampleRow.id}`)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId(`admin-feedback-add-note-${sampleRow.id}`));
    expect(screen.getByTestId(`admin-feedback-note-input-${sampleRow.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`admin-feedback-note-submit-${sampleRow.id}`)).toBeInTheDocument();
  });

  it("submits the note in the PATCH body and reloads", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(
        mkRes({ workspace_id: "w", count: 1, limit: 200, status: "open", feedback: [sampleRow] }),
      ) // initial GET
      .mockResolvedValueOnce(mkRes({ ok: true, feedback: { ...sampleRow, resolved_at: new Date().toISOString(), resolution_note: "fixed via migration 148" } })) // PATCH
      .mockResolvedValueOnce(
        mkRes({ workspace_id: "w", count: 0, limit: 200, status: "open", feedback: [] }),
      ); // reload after PATCH

    await act(async () => {
      render(<FeedbackPage />);
    });
    await waitFor(() =>
      expect(screen.getByTestId(`admin-feedback-add-note-${sampleRow.id}`)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId(`admin-feedback-add-note-${sampleRow.id}`));
    fireEvent.change(screen.getByTestId(`admin-feedback-note-input-${sampleRow.id}`), {
      target: { value: "fixed via migration 148" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId(`admin-feedback-note-submit-${sampleRow.id}`));
    });

    /* Walk the recorded fetch calls until we find the PATCH (analytics
       calls or other side-effects may be interleaved). */
    const patchCall = mockFetchWithRefresh.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes(`/api/admin/feedback/${sampleRow.id}`),
    );
    expect(patchCall).toBeDefined();
    const body = JSON.parse((patchCall![1] as { body: string }).body);
    expect(body).toEqual({ action: "resolve", note: "fixed via migration 148" });
  });

  it("shows 'Filed N times, first on <date>' when a note was de-duplicated", async () => {
    const dupRow = {
      ...sampleRow,
      id: "fb-dup-1",
      created_at: "2026-05-01T10:00:00.000Z",
      times_filed: 3,
      last_filed_at: "2026-05-03T18:00:00.000Z",
    };
    mockFetchWithRefresh.mockResolvedValueOnce(
      mkRes({ workspace_id: "w", count: 1, limit: 200, status: "all", feedback: [dupRow] }),
    );
    await act(async () => {
      render(<FeedbackPage />);
    });
    const line = await screen.findByTestId(`admin-feedback-times-filed-${dupRow.id}`);
    expect(line).toHaveTextContent(/Filed 3 times/i);
    // The original (earliest) date, not a fresh "now".
    expect(line).toHaveTextContent(/first on/i);
    expect(line).toHaveTextContent(/2026/);
  });

  it("does NOT show the times-filed line for a single submission", async () => {
    const singleRow = { ...sampleRow, id: "fb-single-1", times_filed: 1 };
    mockFetchWithRefresh.mockResolvedValueOnce(
      mkRes({ workspace_id: "w", count: 1, limit: 200, status: "all", feedback: [singleRow] }),
    );
    await act(async () => {
      render(<FeedbackPage />);
    });
    await waitFor(() =>
      expect(screen.getByTestId(`admin-feedback-row-${singleRow.id}`)).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId(`admin-feedback-times-filed-${singleRow.id}`),
    ).not.toBeInTheDocument();
  });

  it("plain Mark resolved (no comment) still works and sends no note", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(
        mkRes({ workspace_id: "w", count: 1, limit: 200, status: "open", feedback: [sampleRow] }),
      )
      .mockResolvedValueOnce(mkRes({ ok: true, feedback: { ...sampleRow, resolved_at: new Date().toISOString() } }))
      .mockResolvedValueOnce(
        mkRes({ workspace_id: "w", count: 0, limit: 200, status: "open", feedback: [] }),
      );

    await act(async () => {
      render(<FeedbackPage />);
    });
    await waitFor(() =>
      expect(screen.getByTestId(`admin-feedback-toggle-${sampleRow.id}`)).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId(`admin-feedback-toggle-${sampleRow.id}`));
    });
    const patchCall = mockFetchWithRefresh.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes(`/api/admin/feedback/${sampleRow.id}`),
    );
    expect(patchCall).toBeDefined();
    const body = JSON.parse((patchCall![1] as { body: string }).body);
    expect(body).toEqual({ action: "resolve" });
  });
});
