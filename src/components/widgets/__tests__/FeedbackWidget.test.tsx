/**
 * @jest-environment jsdom
 *
 * FeedbackWidget — both render states (recorded thank-you, compose
 * textarea) plus the compose-mode POST → swap-to-recorded transition.
 */

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { FeedbackWidget } from "@/components/widgets/FeedbackWidget";
import type { FeedbackWidgetSpec } from "@/lib/assistant/widgets/types";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

const RECORDED_SPEC: FeedbackWidgetSpec = {
  kind: "feedback",
  mode: "recorded",
  feedbackId: "abcd1234-0000-0000-0000-000000000000",
  message: "the calendar widget is broken on safari",
  surface: "/assistant",
  submitUrl: "/api/feedback",
};

const COMPOSE_SPEC: FeedbackWidgetSpec = {
  kind: "feedback",
  mode: "compose",
  surface: "/assistant",
  submitUrl: "/api/feedback",
};

beforeEach(() => {
  mockFetch.mockReset();
  /* Default: analytics fire-and-forgets return success. */
  mockFetch.mockResolvedValue(jsonResponse({ ok: true }));
});

describe("FeedbackWidget — recorded mode (thank-you only)", () => {
  test("renders the thank-you header with a short id derived from feedbackId", () => {
    render(<FeedbackWidget spec={RECORDED_SPEC} />);
    expect(screen.getByTestId("feedback-widget")).toHaveAttribute(
      "data-mode",
      "recorded",
    );
    expect(screen.getByTestId("feedback-widget-thanks")).toHaveTextContent(
      /Thanks\. Feedback recorded as #abcd1234\./,
    );
  });

  test("echoes the captured message back to the user", () => {
    render(<FeedbackWidget spec={RECORDED_SPEC} />);
    expect(screen.getByTestId("feedback-widget-echo")).toHaveTextContent(
      "the calendar widget is broken on safari",
    );
  });

  test("does NOT render the textarea / submit affordance in recorded mode", () => {
    render(<FeedbackWidget spec={RECORDED_SPEC} />);
    expect(screen.queryByTestId("feedback-widget-textarea")).toBeNull();
    expect(screen.queryByTestId("feedback-widget-submit")).toBeNull();
  });

  test("fires the widget_opened + widget_rendered analytics on mount", async () => {
    render(<FeedbackWidget spec={RECORDED_SPEC} />);
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/analytics",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("assistant.feedback_widget_opened"),
        }),
      );
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/analytics",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("assistant.widget_rendered"),
        }),
      );
    });
  });
});

describe("FeedbackWidget — compose mode (textarea + submit)", () => {
  test("renders the textarea, character counter, and submit button", () => {
    render(<FeedbackWidget spec={COMPOSE_SPEC} />);
    expect(screen.getByTestId("feedback-widget")).toHaveAttribute(
      "data-mode",
      "compose",
    );
    expect(screen.getByTestId("feedback-widget-textarea")).toBeInTheDocument();
    expect(screen.getByTestId("feedback-widget-submit")).toBeInTheDocument();
    expect(screen.getByTestId("feedback-widget-remaining")).toHaveTextContent(
      /2000 characters left/,
    );
  });

  test("submit is disabled until the user types something", () => {
    render(<FeedbackWidget spec={COMPOSE_SPEC} />);
    const btn = screen.getByTestId("feedback-widget-submit");
    expect(btn).toBeDisabled();
    const ta = screen.getByTestId("feedback-widget-textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "love the widgets" } });
    expect(btn).not.toBeDisabled();
  });

  test("POSTs to spec.submitUrl with the typed message + workflow_id, then swaps to recorded mode", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/feedback") {
        return jsonResponse({ id: "ffee1122-0000-0000-0000-000000000000" }, 201);
      }
      return jsonResponse({ ok: true });
    });

    render(<FeedbackWidget spec={COMPOSE_SPEC} workflowId="wf-42" />);
    const ta = screen.getByTestId("feedback-widget-textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "love the widgets" } });

    await act(async () => {
      fireEvent.click(screen.getByTestId("feedback-widget-submit"));
    });

    /* Verify the POST hit /api/feedback with the right body. */
    const apiCall = mockFetch.mock.calls.find(([u]) => u === "/api/feedback");
    expect(apiCall).toBeDefined();
    const body = JSON.parse(String((apiCall![1] as RequestInit).body));
    expect(body).toEqual({
      message: "love the widgets",
      surface: "/assistant",
      workflow_id: "wf-42",
    });

    /* Widget should now be in recorded mode with the new id surfaced. */
    await waitFor(() => {
      expect(screen.getByTestId("feedback-widget")).toHaveAttribute(
        "data-mode",
        "recorded",
      );
      expect(screen.getByTestId("feedback-widget-thanks")).toHaveTextContent(
        /#ffee1122/,
      );
      expect(screen.getByTestId("feedback-widget-echo")).toHaveTextContent(
        "love the widgets",
      );
    });

    /* And it should have fired the submitted-from-widget analytics. */
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/analytics",
        expect.objectContaining({
          body: expect.stringContaining("assistant.feedback_submitted_from_widget"),
        }),
      );
    });
  });

  test("surfaces a server error and stays in compose mode", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/feedback") {
        return jsonResponse(
          { error: "invalid_input", detail: "message is required" },
          400,
        );
      }
      return jsonResponse({ ok: true });
    });

    render(<FeedbackWidget spec={COMPOSE_SPEC} />);
    const ta = screen.getByTestId("feedback-widget-textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hi" } });

    await act(async () => {
      fireEvent.click(screen.getByTestId("feedback-widget-submit"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("feedback-widget-error")).toHaveTextContent(
        /message is required/,
      );
    });
    expect(screen.getByTestId("feedback-widget")).toHaveAttribute(
      "data-mode",
      "compose",
    );
  });

  test("cmd+enter / ctrl+enter inside the textarea triggers submit", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/feedback") {
        return jsonResponse({ id: "deadbeef-0000-0000-0000-000000000000" }, 201);
      }
      return jsonResponse({ ok: true });
    });

    render(<FeedbackWidget spec={COMPOSE_SPEC} />);
    const ta = screen.getByTestId("feedback-widget-textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "shortcut send" } });

    await act(async () => {
      fireEvent.keyDown(ta, { key: "Enter", metaKey: true });
    });

    await waitFor(() => {
      expect(screen.getByTestId("feedback-widget")).toHaveAttribute(
        "data-mode",
        "recorded",
      );
    });
  });
});
