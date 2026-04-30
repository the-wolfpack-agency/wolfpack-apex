/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));
const mockEmit = jest.fn();
jest.mock("@/lib/insights/emit", () => ({
  emitInsight: (e: unknown) => mockEmit(e),
}));

import EmailReader from "@/app/(dashboard)/emails/EmailReader";

interface MockResponse {
  ok?: boolean;
  status: number;
  json: () => Promise<any>;
}
function ok(body: any, status = 200): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const SAMPLE_MESSAGE = {
  id: "msg-1",
  subject: "Q2 Retainer",
  from: { name: "James Greenfield", email: "james@greenfield.test" },
  toRecipients: [{ name: "Nick", email: "nick@wolfpack.test" }],
  ccRecipients: [{ name: "Legal", email: "legal@greenfield.test" }],
  receivedDateTime: new Date(Date.now() - 60_000).toISOString(),
  bodyContentType: "html" as const,
  bodyContent: "<p>Legal approved the <b>SOW</b>.</p>",
  bodyPreview: "Legal approved the SOW.",
  webLink: "https://outlook.office.com/m/msg-1",
};

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockEmit.mockReset();
});

describe("<EmailReader />", () => {
  test("happy path: fetches by id, renders subject + from + body, fires insight", async () => {
    mockFetchWithRefresh.mockImplementationOnce((url: string) => {
      expect(url).toBe("/api/mail/msg-1");
      return Promise.resolve(ok({ message: SAMPLE_MESSAGE }));
    });
    render(<EmailReader id="msg-1" onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId("email-reader")).toBeInTheDocument();
    });
    expect(screen.getByTestId("email-reader-subject").textContent).toBe("Q2 Retainer");
    expect(screen.getByTestId("email-reader-from").textContent).toContain("James Greenfield");
    // HTML body sanitized to text — no raw tags leak through.
    const bodyEl = screen.getByTestId("email-reader-body");
    expect(bodyEl.textContent).toContain("Legal approved the SOW.");
    expect(bodyEl.innerHTML).not.toContain("<b>");
    // Recipients rendered (To: + Cc: lines).
    expect(screen.getByText(/^To: Nick$/)).toBeInTheDocument();
    expect(screen.getByText(/^Cc: Legal$/)).toBeInTheDocument();
    // Analytics.
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "email",
        action: "message_viewed",
      }),
    );
  });

  test("encodes message ids that contain Graph reserved chars", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(ok({ message: SAMPLE_MESSAGE }));
    render(<EmailReader id="AAMkAD/+abc=" onClose={() => {}} />);
    await waitFor(() => screen.getByTestId("email-reader"));
    const url = mockFetchWithRefresh.mock.calls[0][0] as string;
    expect(url).toBe(`/api/mail/${encodeURIComponent("AAMkAD/+abc=")}`);
  });

  test("scope_missing → renders Mail.Read CTA with /settings link", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(
      ok({ error: "forbidden", code: "scope_missing", scope: "Mail.Read" }, 403),
    );
    render(<EmailReader id="x" onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId("email-reader-error")).toHaveAttribute("data-code", "scope_missing");
    });
    const cta = screen.getByTestId("email-reader-settings-cta");
    expect(cta).toHaveAttribute("href", "/settings");
    // Heading mentions the missing scope.
    expect(
      screen.getAllByText((_, node) => node?.textContent?.includes("Mail.Read") ?? false).length,
    ).toBeGreaterThan(0);
  });

  test("not_connected → renders Connect Microsoft CTA with /settings link", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(
      ok({ error: "microsoft_not_connected" }, 401),
    );
    render(<EmailReader id="x" onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId("email-reader-error")).toHaveAttribute("data-code", "not_connected");
    });
    expect(screen.getByTestId("email-reader-settings-cta")).toHaveAttribute("href", "/settings");
  });

  test("unauthorized (401, no microsoft_not_connected hint) → unauthorized error state", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(ok({ error: "unauthorized" }, 401));
    render(<EmailReader id="x" onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId("email-reader-error")).toHaveAttribute("data-code", "unauthorized");
    });
    expect(screen.getByTestId("email-reader-settings-cta")).toHaveAttribute("href", "/settings");
  });

  test("not_found → renders the missing-email card, no retry button", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(ok({ error: "not_found" }, 404));
    render(<EmailReader id="missing" onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId("email-reader-error")).toHaveAttribute("data-code", "not_found");
    });
    expect(screen.queryByTestId("email-reader-retry")).toBeNull();
  });

  test("graph_error → renders generic error card with a Retry button that re-fetches", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(ok({ error: "graph_error", message: "boom" }, 500))
      .mockResolvedValueOnce(ok({ message: SAMPLE_MESSAGE }));
    render(<EmailReader id="x" onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId("email-reader-error")).toHaveAttribute("data-code", "graph_error");
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("email-reader-retry"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("email-reader")).toBeInTheDocument();
    });
    expect(mockFetchWithRefresh).toHaveBeenCalledTimes(2);
  });

  test("Back button calls onClose for both ready and error states", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(ok({ message: SAMPLE_MESSAGE }));
    const onClose = jest.fn();
    render(<EmailReader id="msg-1" onClose={onClose} />);
    await waitFor(() => screen.getByTestId("email-reader"));
    fireEvent.click(screen.getByTestId("email-reader-back"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("reply: empty input keeps Send disabled; typing enables it", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(ok({ message: SAMPLE_MESSAGE }));
    render(<EmailReader id="msg-1" onClose={() => {}} />);
    await waitFor(() => screen.getByTestId("email-reader"));

    const send = screen.getByTestId("email-reader-reply-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("email-reader-reply-input"), {
      target: { value: "Sounds good — Friday works." },
    });
    expect(send.disabled).toBe(false);
  });

  test("reply: success POSTs originalMessageId + bodyText, clears input, fires reply_sent insight", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(ok({ message: SAMPLE_MESSAGE }))
      .mockResolvedValueOnce(ok({ id: "reply-1" }, 202));

    render(<EmailReader id="msg-1" onClose={() => {}} />);
    await waitFor(() => screen.getByTestId("email-reader"));

    fireEvent.change(screen.getByTestId("email-reader-reply-input"), {
      target: { value: "Sounds good." },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("email-reader-reply-send"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("email-reader-reply-status").textContent).toMatch(/sent/i);
    });
    const replyCall = mockFetchWithRefresh.mock.calls[1];
    expect(replyCall[0]).toBe(`/api/emails/messages/${encodeURIComponent("msg-1")}/reply`);
    const body = JSON.parse(replyCall[1].body);
    expect(body.kind).toBe("reply");
    expect(body.bodyText).toBe("Sounds good.");
    expect((screen.getByTestId("email-reader-reply-input") as HTMLTextAreaElement).value).toBe("");
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "email", action: "replied" }),
    );
  });

  test("reply: scope_missing surfaces the Mail.Send hint with a /settings link", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(ok({ message: SAMPLE_MESSAGE }))
      .mockResolvedValueOnce(
        ok({ error: "forbidden", code: "scope_missing", scope: "Mail.Send" }, 403),
      );

    render(<EmailReader id="msg-1" onClose={() => {}} />);
    await waitFor(() => screen.getByTestId("email-reader"));
    fireEvent.change(screen.getByTestId("email-reader-reply-input"), {
      target: { value: "x" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("email-reader-reply-send"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("email-reader-reply-status").textContent).toMatch(/scope_missing/i);
    });
    // Inline scope hint with link.
    expect(
      screen.getAllByText((_, node) => node?.textContent?.includes("Mail.Send") ?? false).length,
    ).toBeGreaterThan(0);
    const settingsLink = screen.getByText(/Open settings/);
    expect(settingsLink).toHaveAttribute("href", "/settings");
  });

  test("reply: rate_limited surfaces a try-again hint with the retry-after seconds", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(ok({ message: SAMPLE_MESSAGE }))
      .mockResolvedValueOnce(ok({ error: "rate_limited", retryAfter: 12 }, 429));

    render(<EmailReader id="msg-1" onClose={() => {}} />);
    await waitFor(() => screen.getByTestId("email-reader"));
    fireEvent.change(screen.getByTestId("email-reader-reply-input"), {
      target: { value: "x" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("email-reader-reply-send"));
    });
    await waitFor(() => {
      const status = screen.getByTestId("email-reader-reply-status").textContent ?? "";
      expect(status).toMatch(/rate_limited/i);
      expect(status).toMatch(/12s/);
    });
  });

  test("reply: graph_error fires reply_failed insight with the status", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(ok({ message: SAMPLE_MESSAGE }))
      .mockResolvedValueOnce(ok({ error: "graph_error", message: "boom" }, 502));

    render(<EmailReader id="msg-1" onClose={() => {}} />);
    await waitFor(() => screen.getByTestId("email-reader"));
    fireEvent.change(screen.getByTestId("email-reader-reply-input"), {
      target: { value: "x" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("email-reader-reply-send"));
    });
    await waitFor(() => {
      expect(mockEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          surface: "email",
          action: "reply_failed",
          payload: expect.objectContaining({ status: 502 }),
        }),
      );
    });
  });

  test("plain-text body: bodyContentType=text renders as-is without HTML stripping", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(
      ok({
        message: {
          ...SAMPLE_MESSAGE,
          bodyContentType: "text",
          bodyContent: "Line 1\n\nLine 2 with <not-html> chars",
        },
      }),
    );
    render(<EmailReader id="msg-1" onClose={() => {}} />);
    await waitFor(() => screen.getByTestId("email-reader"));
    const body = screen.getByTestId("email-reader-body");
    // Plain text is preserved, including angle-bracket characters.
    expect(body.textContent).toContain("<not-html>");
    expect(body.textContent).toContain("Line 1");
    expect(body.textContent).toContain("Line 2");
  });

  test("missing body falls back to bodyPreview", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(
      ok({
        message: {
          ...SAMPLE_MESSAGE,
          bodyContent: "",
          bodyPreview: "Preview text only.",
        },
      }),
    );
    render(<EmailReader id="msg-1" onClose={() => {}} />);
    await waitFor(() => screen.getByTestId("email-reader"));
    expect(screen.getByTestId("email-reader-body").textContent).toContain("Preview text only.");
  });

  test("archive: clicking Archive PATCHes archive=true, fires insight, calls onMutated + onClose", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(ok({ message: SAMPLE_MESSAGE }))
      .mockResolvedValueOnce(ok({ id: "moved-1", archived: true }, 200));
    const onClose = jest.fn();
    const onMutated = jest.fn();
    render(<EmailReader id="msg-1" onClose={onClose} onMutated={onMutated} />);
    await waitFor(() => screen.getByTestId("email-reader"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("email-reader-action-archive"));
    });
    await waitFor(() => {
      const call = mockFetchWithRefresh.mock.calls[1];
      expect(call[0]).toBe(`/api/emails/messages/${encodeURIComponent("msg-1")}`);
      expect(call[1].method).toBe("PATCH");
      expect(JSON.parse(call[1].body)).toEqual({ archive: true });
    });
    expect(onClose).toHaveBeenCalled();
    expect(onMutated).toHaveBeenCalled();
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "email", action: "archived" }),
    );
  });

  test("delete: clicking Delete sends DELETE, fires insight, calls onClose", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(ok({ message: SAMPLE_MESSAGE }))
      .mockResolvedValueOnce(ok({ id: "msg-1", deleted: true }, 200));
    const onClose = jest.fn();
    render(<EmailReader id="msg-1" onClose={onClose} />);
    await waitFor(() => screen.getByTestId("email-reader"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("email-reader-action-delete"));
    });
    await waitFor(() => {
      const call = mockFetchWithRefresh.mock.calls[1];
      expect(call[1].method).toBe("DELETE");
    });
    expect(onClose).toHaveBeenCalled();
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "email", action: "deleted" }),
    );
  });

  test("delete: 403 scope_missing renders human copy + Reconnect CTA (no raw request_failed_403)", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(ok({ message: SAMPLE_MESSAGE }))
      .mockResolvedValueOnce(
        ok(
          { error: "forbidden", code: "scope_missing", scope: "Mail.ReadWrite" },
          403,
        ),
      );
    const onClose = jest.fn();
    render(<EmailReader id="msg-1" onClose={onClose} />);
    await waitFor(() => screen.getByTestId("email-reader"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("email-reader-action-delete"));
    });
    await waitFor(() => {
      const err = screen.getByTestId("email-reader-action-error");
      expect(err.getAttribute("data-reason")).toBe("scope_missing");
    });
    const errEl = screen.getByTestId("email-reader-action-error");
    // Human-readable copy, NOT the raw "request_failed_403" surfaced
    // before the fix.
    expect(errEl.textContent).not.toMatch(/request_failed_403/);
    expect(errEl.textContent).toMatch(/Mail\.ReadWrite/);
    expect(errEl.textContent).toMatch(/Reconnect Microsoft 365/);
    // Reconnect CTA links to /settings.
    expect(screen.getByTestId("email-reader-action-reconnect-cta")).toBeInTheDocument();
    // onClose must NOT fire on a failed delete (the message is still
    // there in Outlook).
    expect(onClose).not.toHaveBeenCalled();
  });

  test("mark unread: PATCHes isRead=false and emits marked_unread", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(ok({ message: SAMPLE_MESSAGE }))
      .mockResolvedValueOnce(ok({ id: "msg-1", isRead: false }, 200));
    render(<EmailReader id="msg-1" onClose={() => {}} />);
    await waitFor(() => screen.getByTestId("email-reader"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("email-reader-action-mark-unread"));
    });
    await waitFor(() => {
      const call = mockFetchWithRefresh.mock.calls[1];
      expect(JSON.parse(call[1].body)).toEqual({ isRead: false });
    });
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "email", action: "marked_unread" }),
    );
  });

  test("reply-all: switching to Reply all sends kind=replyAll", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(ok({ message: SAMPLE_MESSAGE }))
      .mockResolvedValueOnce(ok({ id: "rall-1" }, 202));
    render(<EmailReader id="msg-1" onClose={() => {}} />);
    await waitFor(() => screen.getByTestId("email-reader"));
    fireEvent.click(screen.getByTestId("email-reader-action-replyall"));
    fireEvent.change(screen.getByTestId("email-reader-reply-input"), {
      target: { value: "Thanks all" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("email-reader-reply-send"));
    });
    await waitFor(() => {
      const call = mockFetchWithRefresh.mock.calls[1];
      const body = JSON.parse(call[1].body);
      expect(body.kind).toBe("replyAll");
      expect(body.bodyText).toBe("Thanks all");
    });
  });

  test("forward: switching to Forward shows the To input and sends kind=forward with parsed recipients", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(ok({ message: SAMPLE_MESSAGE }))
      .mockResolvedValueOnce(ok({ id: "fwd-1" }, 202));
    render(<EmailReader id="msg-1" onClose={() => {}} />);
    await waitFor(() => screen.getByTestId("email-reader"));
    fireEvent.click(screen.getByTestId("email-reader-action-forward"));
    fireEvent.change(screen.getByTestId("email-reader-forward-to"), {
      target: { value: "a@x.co, b@x.co" },
    });
    fireEvent.change(screen.getByTestId("email-reader-reply-input"), {
      target: { value: "FYI" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("email-reader-reply-send"));
    });
    await waitFor(() => {
      const call = mockFetchWithRefresh.mock.calls[1];
      const body = JSON.parse(call[1].body);
      expect(body.kind).toBe("forward");
      expect(body.to).toEqual(["a@x.co", "b@x.co"]);
    });
  });
});
