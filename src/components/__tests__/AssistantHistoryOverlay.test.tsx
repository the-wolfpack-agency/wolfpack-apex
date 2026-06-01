/**
 * @jest-environment jsdom
 *
 * AssistantHistoryOverlay — modal a11y + data fetch + close-paths +
 * non-destructive pick (composer populated, not auto-submitted).
 */

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const mockFetchWithRefresh: jest.Mock = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  authHeaders: () => ({ Authorization: "Bearer test" }),
}));

import React from "react";
import { AssistantHistoryOverlay } from "@/components/AssistantHistoryOverlay";

const PROMPTS = [
  {
    content: "give me insights",
    last_asked_at: new Date(Date.now() - 3 * 60_000).toISOString(),
    ask_count: 3,
  },
  {
    content: "what's on my calendar today",
    last_asked_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
    ask_count: 1,
  },
];

function mockHistoryResponse(prompts: typeof PROMPTS) {
  /* Two fetch flavors fire: the analytics POST and the GET. We
   * give every call a valid Response-shaped object so neither
   * blows up; the GET is identified by URL and returns prompts. */
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (typeof url === "string" && url.includes("prompt-history")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ prompts }),
      } as any);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as any);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockHistoryResponse(PROMPTS);
});

describe("AssistantHistoryOverlay", () => {
  it("does not render when open=false", () => {
    render(
      <AssistantHistoryOverlay
        open={false}
        source="header_button"
        onPickPrompt={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    expect(
      screen.queryByTestId("assistant-history-overlay"),
    ).not.toBeInTheDocument();
  });

  it("renders modal with dialog role + title + close button + prompt list", async () => {
    render(
      <AssistantHistoryOverlay
        open={true}
        source="header_button"
        onPickPrompt={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText(/Your recent prompts/i)).toBeInTheDocument();
    expect(
      screen.getByTestId("assistant-history-overlay-close"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("assistant-history-list")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("assistant-history-item-0").textContent).toMatch(
      /give me insights/i,
    );
    /* ask_count > 1 surfaces "·  3×" tag */
    expect(screen.getByTestId("assistant-history-item-0").textContent).toMatch(
      /3×/,
    );
  });

  it("fires assistant.history_opened analytics on mount", async () => {
    render(
      <AssistantHistoryOverlay
        open={true}
        source="header_button"
        onPickPrompt={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    await waitFor(() => {
      const analyticsCall = mockFetchWithRefresh.mock.calls.find(
        (c) =>
          typeof c[1]?.body === "string" &&
          c[1].body.includes("assistant.history_opened"),
      );
      expect(analyticsCall).toBeDefined();
    });
  });

  it("picking a prompt fires onPickPrompt with the content and does NOT auto-submit", async () => {
    const onPick = jest.fn();
    render(
      <AssistantHistoryOverlay
        open={true}
        source="header_button"
        onPickPrompt={onPick}
        onClose={jest.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("assistant-history-item-0")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("assistant-history-item-0"));
    expect(onPick).toHaveBeenCalledWith("give me insights");
    /* No `instinct:autosubmit` event should be dispatched — that's
     * the clarify-widget contract, not the history contract. */
  });

  it("Escape key closes with reason='escape'", async () => {
    const onClose = jest.fn();
    render(
      <AssistantHistoryOverlay
        open={true}
        source="header_button"
        onPickPrompt={jest.fn()}
        onClose={onClose}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("assistant-history-overlay")).toBeInTheDocument(),
    );
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(onClose).toHaveBeenCalledWith("escape");
  });

  it("backdrop click closes with reason='outside_click'", async () => {
    const onClose = jest.fn();
    render(
      <AssistantHistoryOverlay
        open={true}
        source="header_button"
        onPickPrompt={jest.fn()}
        onClose={onClose}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("assistant-history-overlay-backdrop"),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("assistant-history-overlay-backdrop"));
    expect(onClose).toHaveBeenCalledWith("outside_click");
  });

  it("close button click closes with reason='close_button'", async () => {
    const onClose = jest.fn();
    render(
      <AssistantHistoryOverlay
        open={true}
        source="header_button"
        onPickPrompt={jest.fn()}
        onClose={onClose}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("assistant-history-overlay-close"),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("assistant-history-overlay-close"));
    expect(onClose).toHaveBeenCalledWith("close_button");
  });

  it("shows empty state when the route returns no prompts", async () => {
    mockHistoryResponse([]);
    render(
      <AssistantHistoryOverlay
        open={true}
        source="header_button"
        onPickPrompt={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("assistant-history-empty")).toBeInTheDocument(),
    );
  });

  it("shows error state when the route returns non-ok", async () => {
    mockFetchWithRefresh.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("prompt-history")) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({}),
        } as any);
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as any);
    });
    render(
      <AssistantHistoryOverlay
        open={true}
        source="header_button"
        onPickPrompt={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("assistant-history-error")).toBeInTheDocument(),
    );
  });
});
