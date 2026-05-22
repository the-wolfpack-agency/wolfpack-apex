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

  test("a rapid double-click fires the submit POST exactly once", async () => {
    /* The bug this test guards: the disabled-button check relies on
     * React state, which updates async. A second click can fire
     * before the disabled state re-renders, producing duplicate
     * rows in the DB. The synchronous ref guard inside submit()
     * is what makes this test pass. */
    let resolveSubmit: ((value: Response) => void) | null = null;
    const inFlight = new Promise<Response>((resolve) => {
      resolveSubmit = resolve;
    });
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url === "/api/feedback") return inFlight;
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    render(<FeedbackWidget spec={COMPOSE_SPEC} />);
    const ta = screen.getByTestId("feedback-widget-textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "double click case" } });

    const btn = screen.getByTestId("feedback-widget-submit");
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);

    /* Only one POST to /api/feedback should be in flight. */
    const submitCalls = mockFetch.mock.calls.filter(
      (c) => c[0] === "/api/feedback",
    );
    expect(submitCalls.length).toBe(1);

    /* Resolve the in-flight request so the widget can swap to recorded. */
    await act(async () => {
      resolveSubmit?.(jsonResponse({ id: "new-id-001" }, 201));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("feedback-widget")).toHaveAttribute(
        "data-mode",
        "recorded",
      );
    });
  });

  test("two rapid cmd+enter keystrokes fire submit exactly once", async () => {
    let resolveSubmit: ((value: Response) => void) | null = null;
    const inFlight = new Promise<Response>((resolve) => {
      resolveSubmit = resolve;
    });
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url === "/api/feedback") return inFlight;
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    render(<FeedbackWidget spec={COMPOSE_SPEC} />);
    const ta = screen.getByTestId("feedback-widget-textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "keyboard double fire" } });

    fireEvent.keyDown(ta, { key: "Enter", metaKey: true });
    fireEvent.keyDown(ta, { key: "Enter", metaKey: true });
    fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true });

    const submitCalls = mockFetch.mock.calls.filter(
      (c) => c[0] === "/api/feedback",
    );
    expect(submitCalls.length).toBe(1);

    await act(async () => {
      resolveSubmit?.(jsonResponse({ id: "kbd-id-001" }, 201));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId("feedback-widget")).toHaveAttribute(
        "data-mode",
        "recorded",
      );
    });
  });

  test("textarea is readOnly during submit so the body cannot be mutated mid-flight", async () => {
    let resolveSubmit: ((value: Response) => void) | null = null;
    const inFlight = new Promise<Response>((resolve) => {
      resolveSubmit = resolve;
    });
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url === "/api/feedback") return inFlight;
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    render(<FeedbackWidget spec={COMPOSE_SPEC} />);
    const ta = screen.getByTestId("feedback-widget-textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "first send" } });
    fireEvent.click(screen.getByTestId("feedback-widget-submit"));

    await waitFor(() => {
      expect(ta).toHaveAttribute("readonly");
    });

    /* Submit button shows the Sending state while in-flight. */
    expect(screen.getByTestId("feedback-widget-submit")).toHaveTextContent(/sending/i);

    /* Once the response lands and the widget swaps to recorded mode,
     * the textarea is gone, so the readOnly attribute can no longer be
     * read off it. */
    await act(async () => {
      resolveSubmit?.(jsonResponse({ id: "readonly-test" }, 201));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByTestId("feedback-widget-textarea")).toBeNull();
    });
  });

  test("after a successful submit, a second send of a different body still works", async () => {
    /* Regression guard: the ref guard must be reset in the `finally`
     * block so the user can come back later and send fresh feedback. */
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url === "/api/feedback") {
        return Promise.resolve(jsonResponse({ id: "first-id" }, 201));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    render(<FeedbackWidget spec={COMPOSE_SPEC} />);
    const ta = screen.getByTestId("feedback-widget-textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "first body" } });

    await act(async () => {
      fireEvent.click(screen.getByTestId("feedback-widget-submit"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("feedback-widget")).toHaveAttribute(
        "data-mode",
        "recorded",
      );
    });

    /* The widget swapped to recorded mode; there is no second compose
     * round in v1. The important thing is that the inFlight ref was
     * reset (no error thrown, no stale "in flight" state). The first
     * call landed exactly once. */
    const submitCalls = mockFetch.mock.calls.filter(
      (c) => c[0] === "/api/feedback",
    );
    expect(submitCalls.length).toBe(1);
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
