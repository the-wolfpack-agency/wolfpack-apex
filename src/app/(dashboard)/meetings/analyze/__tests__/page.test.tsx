/** @jest-environment jsdom */
 
import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
}));

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: (...a: any[]) => mockPush(...a) }),
}));

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import MeetingsAnalyzePage from "@/app/(dashboard)/meetings/analyze/page";

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockPush.mockReset();
});

function mockAnalyze(payload: unknown, status = 200) {
  mockFetchWithRefresh.mockImplementation(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    }),
  );
}

const SAMPLE = {
  matched_messages: [
    {
      id: "m1",
      feed_id: "f1",
      feed_slug: "weekly",
      feed_name: "Weekly",
      subject: "Weekly recap",
      from_address: "ops@example.com",
      received_at: "2026-04-15T00:00:00Z",
      has_analysis: true,
    },
  ],
  aggregated_themes: [
    { topic: "pricing", mention_count: 3, first_seen: null, last_seen: null },
  ],
  aggregated_action_items: [
    { description: "Ship pricing page", assignee: "alice" },
  ],
  aggregated_decisions: [{ description: "Move release to Friday" }],
  counts: { matched: 1, analyzed: 1, feeds_touched: 1 },
  filters: { subject_match: ["weekly"], sender_match: [] },
};

describe("MeetingsAnalyzePage", () => {
  it("submits filters and renders aggregated results", async () => {
    mockAnalyze(SAMPLE);
    render(<MeetingsAnalyzePage />);
    fireEvent.change(screen.getByTestId("analyze-subjects"), {
      target: { value: "weekly" },
    });
    fireEvent.click(screen.getByTestId("analyze-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("analyze-results")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("analyze-themes")).toHaveTextContent(/pricing/i);
    expect(screen.getByTestId("analyze-actions")).toHaveTextContent(
      /Ship pricing page/,
    );
    expect(screen.getByTestId("analyze-decisions")).toHaveTextContent(
      /Move release/,
    );
    expect(screen.getByTestId("analyze-messages")).toHaveTextContent(
      /Weekly recap/,
    );
  });

  it("shows error on 400", async () => {
    mockAnalyze({ error: "invalid_input", detail: "subject required" }, 400);
    render(<MeetingsAnalyzePage />);
    fireEvent.change(screen.getByTestId("analyze-subjects"), {
      target: { value: "weekly" },
    });
    fireEvent.click(screen.getByTestId("analyze-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("analyze-error")).toHaveTextContent(
        /subject required/,
      ),
    );
  });

  it("save-as-feed routes to /meetings/feeds with prefill query", async () => {
    mockAnalyze(SAMPLE);
    render(<MeetingsAnalyzePage />);
    fireEvent.change(screen.getByTestId("analyze-subjects"), {
      target: { value: "weekly" },
    });
    fireEvent.click(screen.getByTestId("analyze-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("analyze-save-as-feed")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("analyze-save-as-feed"));
    expect(mockPush).toHaveBeenCalledWith(
      expect.stringContaining("/meetings/feeds?prefill="),
    );
  });
});
