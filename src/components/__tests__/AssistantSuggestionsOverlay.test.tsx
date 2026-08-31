/**
 * @jest-environment jsdom
 *
 * AssistantSuggestionsOverlay — modal a11y + analytics + close-paths.
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";

const mockFetchWithRefresh: jest.Mock = jest.fn(() =>
  Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
);
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: mockFetchWithRefresh,
}));

/* The overlay renders AssistantStarterPrompts, which fetches
 * /api/integrations/status. We stub it to a simple expandable card
 * so the test focuses on the overlay's contract, not the panel's
 * inner rendering (covered by its own suite). */
jest.mock("@/components/AssistantStarterPrompts", () => ({
  AssistantStarterPrompts: ({ onPick }: { onPick: (p: string) => void }) => (
    <button
      data-testid="mock-starter-pick"
      onClick={() => onPick("show me cross-tool insights")}
    >
      pick
    </button>
  ),
}));

import React from "react";
import { AssistantSuggestionsOverlay } from "@/components/AssistantSuggestionsOverlay";

beforeEach(() => {
  mockFetchWithRefresh.mockClear();
});

describe("AssistantSuggestionsOverlay", () => {
  test("renders nothing when open=false", () => {
    render(
      <AssistantSuggestionsOverlay
        open={false}
        source="header_button"
        onPickPrompt={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    expect(
      screen.queryByTestId("assistant-suggestions-overlay"),
    ).toBeNull();
  });

  test("renders dialog with proper a11y attributes when open", () => {
    render(
      <AssistantSuggestionsOverlay
        open={true}
        source="header_button"
        onPickPrompt={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    const backdrop = screen.getByTestId(
      "assistant-suggestions-overlay-backdrop",
    );
    expect(backdrop).toHaveAttribute("role", "dialog");
    expect(backdrop).toHaveAttribute("aria-modal", "true");
    expect(backdrop).toHaveAttribute(
      "aria-labeledby",
      "assistant-suggestions-title",
    );
    expect(
      screen.getByText("What can I help you with?"),
    ).toBeInTheDocument();
  });

  test("Escape key invokes onClose('escape')", () => {
    const onClose = jest.fn();
    render(
      <AssistantSuggestionsOverlay
        open={true}
        source="header_button"
        onPickPrompt={jest.fn()}
        onClose={onClose}
      />,
    );
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledWith("escape");
  });

  test("clicking the backdrop invokes onClose('outside_click')", () => {
    const onClose = jest.fn();
    render(
      <AssistantSuggestionsOverlay
        open={true}
        source="header_button"
        onPickPrompt={jest.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.click(
      screen.getByTestId("assistant-suggestions-overlay-backdrop"),
    );
    expect(onClose).toHaveBeenCalledWith("outside_click");
  });

  test("clicking inside the panel does NOT close it (stopPropagation)", () => {
    const onClose = jest.fn();
    render(
      <AssistantSuggestionsOverlay
        open={true}
        source="header_button"
        onPickPrompt={jest.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId("assistant-suggestions-overlay"));
    expect(onClose).not.toHaveBeenCalled();
  });

  test("close button invokes onClose('close_button')", () => {
    const onClose = jest.fn();
    render(
      <AssistantSuggestionsOverlay
        open={true}
        source="header_button"
        onPickPrompt={jest.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.click(
      screen.getByTestId("assistant-suggestions-overlay-close"),
    );
    expect(onClose).toHaveBeenCalledWith("close_button");
  });

  test("emits assistant.suggestions_opened analytics on open, with source", () => {
    render(
      <AssistantSuggestionsOverlay
        open={true}
        source="slash_command"
        onPickPrompt={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    expect(mockFetchWithRefresh).toHaveBeenCalledWith(
      "/api/analytics",
      expect.objectContaining({
        body: expect.stringContaining("suggestions_opened"),
      }),
    );
    const body = JSON.parse(
      (mockFetchWithRefresh.mock.calls[0][1] as { body: string }).body,
    );
    expect(body.metadata.source).toBe("slash_command");
  });

  test("picking a prompt fires analytics + forwards to onPickPrompt", () => {
    const onPickPrompt = jest.fn();
    render(
      <AssistantSuggestionsOverlay
        open={true}
        source="header_button"
        onPickPrompt={onPickPrompt}
        onClose={jest.fn()}
      />,
    );
    mockFetchWithRefresh.mockClear();
    fireEvent.click(screen.getByTestId("mock-starter-pick"));
    expect(onPickPrompt).toHaveBeenCalledWith("show me cross-tool insights");
    expect(mockFetchWithRefresh).toHaveBeenCalledWith(
      "/api/analytics",
      expect.objectContaining({
        body: expect.stringContaining("suggestion_picked_from_overlay"),
      }),
    );
  });
});
