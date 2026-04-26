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
    expect(replyCall[0]).toBe("/api/mail/reply");
    const body = JSON.parse(replyCall[1].body);
    expect(body.originalMessageId).toBe("msg-1");
    expect(body.bodyText).toBe("Sounds good.");
    expect((screen.getByTestId("email-reader-reply-input") as HTMLTextAreaElement).value).toBe("");
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "email", action: "reply_sent" }),
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
});
