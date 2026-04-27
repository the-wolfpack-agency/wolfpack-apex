/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockFetchWithRefresh = jest.fn();
const mockGetInstinctUser = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  getInstinctUser: () => mockGetInstinctUser(),
}));

import TicketDetail, {
  inferRecipient,
} from "@/app/(dashboard)/support/_components/TicketDetail";
import type { SupportTicket } from "@/app/(dashboard)/support/_components/TicketList";

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockGetInstinctUser.mockReset();
  mockGetInstinctUser.mockReturnValue(null);
});

function makeTicket(overrides: Partial<SupportTicket> = {}): SupportTicket {
  return {
    id: "tkt_1",
    title: "Login fails with AADSTS20012",
    body: "User user@example.com gets AADSTS20012 every time they log in.",
    diagnostic_text: "AADSTS20012: WS-Federation issuer mismatch",
    category: "m365",
    severity: "p1",
    status: "drafted",
    draft_response: "Try reconnecting Outlook from /settings/integrations.",
    drafted_at: new Date(Date.now() - 4 * 60_000).toISOString(),
    created_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    created_by: "Alicia",
    matched_patterns: ["AADSTS20012 WS-Fed troubleshooting"],
    ...overrides,
  };
}

describe("inferRecipient", () => {
  test("pulls the first email from the body", () => {
    const t = makeTicket({
      body: "Hi, please help support@whatever.com — they can't log in.",
      diagnostic_text: undefined,
    });
    expect(inferRecipient(t)).toBe("support@whatever.com");
  });

  test("falls back to the diagnostic text", () => {
    const t = makeTicket({
      body: "no email here",
      diagnostic_text: "see other@x.org logs",
    });
    expect(inferRecipient(t)).toBe("other@x.org");
  });

  test("returns empty string when nothing matches", () => {
    const t = makeTicket({ body: "no email", diagnostic_text: "nothing" });
    expect(inferRecipient(t)).toBe("");
  });
});

describe("<TicketDetail /> — drafted state", () => {
  test("renders header, body, and draft sections", () => {
    const t = makeTicket();
    render(<TicketDetail ticket={t} onTicketUpdated={() => {}} />);
    expect(screen.getByTestId("ticket-detail-header").textContent).toMatch(
      /Login fails/,
    );
    expect(screen.getByTestId("ticket-detail-body").textContent).toMatch(
      /AADSTS20012 every time/,
    );
    expect(
      (screen.getByTestId("ticket-detail-draft-textarea") as HTMLTextAreaElement)
        .value,
    ).toBe(t.draft_response);
    expect(screen.getByTestId("ticket-detail-matches").textContent).toMatch(
      /AADSTS20012 WS-Fed troubleshooting/,
    );
  });

  test("Regenerate calls POST /api/support/tickets/[id]/draft and updates the ticket", async () => {
    const t = makeTicket();
    const updated = makeTicket({
      draft_response: "fresher draft text",
      drafted_at: new Date().toISOString(),
    });
    mockFetchWithRefresh.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => updated,
    });

    const onTicketUpdated = jest.fn();
    render(<TicketDetail ticket={t} onTicketUpdated={onTicketUpdated} />);

    fireEvent.click(screen.getByTestId("ticket-detail-regenerate"));

    await waitFor(() => {
      expect(onTicketUpdated).toHaveBeenCalledWith(updated);
    });

    const [url, init] = mockFetchWithRefresh.mock.calls[0];
    expect(url).toBe(`/api/support/tickets/${t.id}/draft`);
    expect((init as RequestInit).method).toBe("POST");
  });

  test("Send button opens the preview modal with inferred recipient and default subject", () => {
    const t = makeTicket({
      body: "Reach me at user@example.com",
    });
    render(<TicketDetail ticket={t} onTicketUpdated={() => {}} />);

    fireEvent.click(screen.getByTestId("ticket-detail-open-send"));

    expect(screen.getByTestId("ticket-detail-send-modal")).toBeInTheDocument();
    expect(
      (screen.getByTestId("send-modal-to") as HTMLInputElement).value,
    ).toBe("user@example.com");
    expect(
      (screen.getByTestId("send-modal-subject") as HTMLInputElement).value,
    ).toBe(`Re: ${t.title}`);
    // From line shows support@thewolfpack.agency.
    expect(screen.getByTestId("send-modal-from").textContent).toMatch(
      /support@thewolfpack\.agency/,
    );
    // Body defaults to the current draft.
    expect(
      (screen.getByTestId("send-modal-body") as HTMLTextAreaElement).value,
    ).toBe(t.draft_response);
  });

  test("Confirming send POSTs to /send and switches to the sent presentation", async () => {
    const t = makeTicket({
      body: "Reach me at user@example.com",
    });
    const sentTicket = {
      ...t,
      status: "sent" as const,
      sent_response: "Try reconnecting Outlook from /settings/integrations.",
      sent_to: "user@example.com",
      sent_at: new Date().toISOString(),
    };
    mockFetchWithRefresh.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => sentTicket,
    });

    const onTicketUpdated = jest.fn();
    const Wrapper = () => {
      const [tk, setTk] = require("react").useState(t);
      return (
        <TicketDetail
          ticket={tk}
          onTicketUpdated={(next: SupportTicket) => {
            onTicketUpdated(next);
            setTk(next);
          }}
        />
      );
    };
    render(<Wrapper />);

    fireEvent.click(screen.getByTestId("ticket-detail-open-send"));
    fireEvent.click(screen.getByTestId("send-modal-confirm"));

    await waitFor(() => {
      expect(onTicketUpdated).toHaveBeenCalledWith(sentTicket);
    });

    const [url, init] = mockFetchWithRefresh.mock.calls[0];
    expect(url).toBe(`/api/support/tickets/${t.id}/send`);
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse(((init as RequestInit).body as string) ?? "{}");
    expect(body.to_email).toBe("user@example.com");
    expect(body.subject).toBe(`Re: ${t.title}`);
    expect(body.body).toBe(t.draft_response);
  });

  test("Send modal blocks confirm when the email is invalid", async () => {
    const t = makeTicket({ body: "no email here", diagnostic_text: "nothing" });
    render(<TicketDetail ticket={t} onTicketUpdated={() => {}} />);

    fireEvent.click(screen.getByTestId("ticket-detail-open-send"));
    fireEvent.change(screen.getByTestId("send-modal-to"), {
      target: { value: "not-an-email" },
    });
    fireEvent.click(screen.getByTestId("send-modal-confirm"));

    await waitFor(() => {
      expect(screen.getByTestId("send-modal-error").textContent).toMatch(
        /valid email/,
      );
    });
    expect(mockFetchWithRefresh).not.toHaveBeenCalled();
  });
});

describe("<TicketDetail /> — audience routing", () => {
  test("renders an audience badge in the header for the ticket's audience", () => {
    const t = makeTicket({ audience: "client" });
    render(<TicketDetail ticket={t} onTicketUpdated={() => {}} />);
    /* Header shows the badge so an operator can immediately tell
       client-vs-internal at a glance, alongside severity + status. */
    expect(screen.getByTestId("audience-badge-client")).toBeInTheDocument();
  });

  test("send modal From: defaults to support@ for client and operator email for internal", () => {
    /* Client ticket: From: defaults to the support address. */
    const clientTicket = makeTicket({
      audience: "client",
      body: "Reach me at user@example.com",
    });
    const { unmount } = render(
      <TicketDetail ticket={clientTicket} onTicketUpdated={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("ticket-detail-open-send"));
    expect(
      (screen.getByTestId("send-modal-from-input") as HTMLInputElement).value,
    ).toBe("support@thewolfpack.agency");
    expect(screen.getByTestId("send-modal-from").getAttribute("data-audience"))
      .toBe("client");
    unmount();

    /* Internal ticket with a known operator email: From: pre-fills the
       operator's address so the reply leaves from a recognizable inbox. */
    mockGetInstinctUser.mockReturnValue({ email: "homyk@thewolfpack.agency" });
    const internalTicket = makeTicket({
      audience: "internal",
      body: "Reach me at user@example.com",
    });
    render(<TicketDetail ticket={internalTicket} onTicketUpdated={() => {}} />);
    fireEvent.click(screen.getByTestId("ticket-detail-open-send"));
    expect(
      (screen.getByTestId("send-modal-from-input") as HTMLInputElement).value,
    ).toBe("homyk@thewolfpack.agency");
    expect(screen.getByTestId("send-modal-from").getAttribute("data-audience"))
      .toBe("internal");
  });
});

describe("<TicketDetail /> — sent state + feedback", () => {
  test("renders the sent panel and the feedback widget", () => {
    const t = makeTicket({
      status: "sent",
      sent_response: "Final body",
      sent_to: "user@example.com",
      sent_at: new Date().toISOString(),
    });
    render(<TicketDetail ticket={t} onTicketUpdated={() => {}} />);
    expect(screen.getByTestId("ticket-detail-sent")).toBeInTheDocument();
    expect(screen.getByTestId("ticket-detail-sent-body").textContent).toBe(
      "Final body",
    );
    expect(screen.getByTestId("ticket-detail-sent-meta").textContent).toMatch(
      /user@example\.com/,
    );
    expect(screen.getByTestId("ticket-detail-feedback")).toBeInTheDocument();
  });

  test("Yes-it-helped POSTs to /feedback with helpful=true and edit_diff", async () => {
    const t = makeTicket({
      status: "sent",
      draft_response: "original draft text",
      sent_response: "edited final text",
      sent_to: "user@example.com",
      sent_at: new Date().toISOString(),
    });
    const updated = { ...t, feedback_helpful: true };
    mockFetchWithRefresh.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => updated,
    });
    const onTicketUpdated = jest.fn();
    render(<TicketDetail ticket={t} onTicketUpdated={onTicketUpdated} />);

    fireEvent.click(screen.getByTestId("ticket-detail-feedback-yes"));

    await waitFor(() => {
      expect(onTicketUpdated).toHaveBeenCalledWith(updated);
    });
    const [url, init] = mockFetchWithRefresh.mock.calls[0];
    expect(url).toBe(`/api/support/tickets/${t.id}/feedback`);
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse(((init as RequestInit).body as string) ?? "{}");
    expect(body.helpful).toBe(true);
    expect(body.edit_diff).toEqual({
      original: "original draft text",
      edited: "edited final text",
    });
  });

  test("No-it-didn't reveals the notes form, then submits with helpful=false", async () => {
    const t = makeTicket({
      status: "sent",
      draft_response: "original",
      sent_response: "edited",
      sent_to: "user@example.com",
      sent_at: new Date().toISOString(),
    });
    const updated = {
      ...t,
      feedback_helpful: false,
      feedback_notes: "missed the actual fix",
    };
    mockFetchWithRefresh.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => updated,
    });
    const onTicketUpdated = jest.fn();
    render(<TicketDetail ticket={t} onTicketUpdated={onTicketUpdated} />);

    fireEvent.click(screen.getByTestId("ticket-detail-feedback-no"));
    expect(
      screen.getByTestId("ticket-detail-feedback-no-form"),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("ticket-detail-feedback-notes"), {
      target: { value: "missed the actual fix" },
    });
    fireEvent.click(screen.getByTestId("ticket-detail-feedback-submit"));

    await waitFor(() => {
      expect(onTicketUpdated).toHaveBeenCalledWith(updated);
    });
    const body = JSON.parse(
      ((mockFetchWithRefresh.mock.calls[0][1] as RequestInit).body as string) ??
        "{}",
    );
    expect(body.helpful).toBe(false);
    expect(body.notes).toBe("missed the actual fix");
  });

  test("once feedback is recorded, the widget shows the recorded message instead of buttons", () => {
    const t = makeTicket({
      status: "sent",
      sent_response: "x",
      sent_to: "u@x.com",
      sent_at: new Date().toISOString(),
      feedback_helpful: true,
    });
    render(<TicketDetail ticket={t} onTicketUpdated={() => {}} />);
    expect(
      screen.getByTestId("ticket-detail-feedback-recorded"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("ticket-detail-feedback-yes")).toBeNull();
  });
});
