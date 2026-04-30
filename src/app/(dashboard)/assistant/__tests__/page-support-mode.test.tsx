/**
 * @jest-environment jsdom
 *
 * /assistant — support-mode pill tests.
 *
 *   1. The support pill toggles the AssistantSupportPanel.
 *   2. A low-confidence answer surfaces the "Submit a support ticket" CTA.
 */

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

jest.mock("@/components/InstinctChat", () => ({
  __esModule: true,
  default: () => <div data-testid="instinct-chat-mount" />,
}));

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetchWithRefresh(...a),
  jsonHeaders: () => ({
    "Content-Type": "application/json",
    Authorization: "Bearer x",
  }),
}));

import AssistantPage from "@/app/(dashboard)/assistant/page";

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

test("support pill toggles the support panel", async () => {
  render(<AssistantPage />);
  expect(screen.queryByTestId("assistant-support-panel")).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId("assistant-support-pill"));
  expect(screen.getByTestId("assistant-support-panel")).toBeInTheDocument();
  fireEvent.click(screen.getByTestId("assistant-support-pill"));
  expect(screen.queryByTestId("assistant-support-panel")).not.toBeInTheDocument();
});

test("low-confidence answer surfaces the ticket CTA", async () => {
  mockFetchWithRefresh.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      qa_id: "q-low",
      answer: "I don't know.",
      source: "ai_generated",
      ai_model: "x/y",
      ai_generated_at: "2026-04-29T00:00:00Z",
      was_cache_hit: false,
      similarity: 0,
      latency_ms: 25,
      low_confidence: true,
    }),
  }));

  render(<AssistantPage />);
  fireEvent.click(screen.getByTestId("assistant-support-pill"));
  fireEvent.change(screen.getByTestId("assistant-support-input"), {
    target: { value: "What is the answer to obscure question 42?" },
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("assistant-support-submit"));
  });
  await waitFor(() =>
    expect(
      screen.getByTestId("assistant-support-ticket-cta"),
    ).toBeInTheDocument(),
  );
  /* AI badge must always be present when source='ai_generated'. */
  expect(screen.getByTestId("assistant-support-ai-badge")).toBeInTheDocument();
});

test("high-confidence answer does NOT surface ticket CTA", async () => {
  mockFetchWithRefresh.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      qa_id: "q-high",
      answer:
        "Click your avatar in the top-right corner, choose Settings, then Reset password. The link expires after 60 minutes.",
      source: "ai_generated",
      ai_model: "x/y",
      ai_generated_at: "2026-04-29T00:00:00Z",
      was_cache_hit: false,
      similarity: 0,
      latency_ms: 25,
      low_confidence: false,
    }),
  }));

  render(<AssistantPage />);
  fireEvent.click(screen.getByTestId("assistant-support-pill"));
  fireEvent.change(screen.getByTestId("assistant-support-input"), {
    target: { value: "How do I reset my password?" },
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("assistant-support-submit"));
  });
  await waitFor(() =>
    expect(screen.getByTestId("assistant-support-answer")).toBeInTheDocument(),
  );
  expect(
    screen.queryByTestId("assistant-support-ticket-cta"),
  ).not.toBeInTheDocument();
});
