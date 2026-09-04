/**
 * @jest-environment jsdom
 */

/**
 * The compose surface for a message that cannot be unsent.
 *
 * Most of what is asserted here is about restraint: that one click does not
 * send, that the confirmation names a real number of people rather than the
 * word "everyone", and that no outcome is reported more cheerfully than what
 * the server actually said. A sender told "delivered" does not send again, so
 * an optimistic success message is the one failure that guarantees the company
 * never hears the announcement.
 */
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockPush = jest.fn();
const mockUser = jest.fn();
const mockFetch = jest.fn();

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock("@/lib/client-auth", () => ({
  getInstinctUser: () => mockUser(),
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
}));

import Page from "@/app/(dashboard)/admin/broadcast/page";

function json(body: unknown, status = 200) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUser.mockReturnValue({ role: "cto" });
  mockFetch.mockImplementation((url: string, init?: { method?: string }) => {
    if (!init?.method) return json({ recipients: 42, readable: true });
    return json({ delivered: 42, failed: 0, redacted: [] });
  });
});

describe("access", () => {
  /* An authenticated admin page must redirect, never render empty. */
  it("sends an unauthenticated visitor to the login page", () => {
    mockUser.mockReturnValue(null);
    render(<Page />);
    expect(mockPush).toHaveBeenCalledWith("/login?next=/admin/broadcast");
  });
});

describe("sending is deliberate", () => {
  it("cannot be sent with nothing typed", () => {
    render(<Page />);
    expect(screen.getByTestId("broadcast-send")).toBeDisabled();
  });

  /* ONE CLICK ASKS. It does not send. */
  it("asks before sending, rather than sending on the first click", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.type(screen.getByTestId("broadcast-message"), "Office closed Monday.");
    await user.click(screen.getByTestId("broadcast-send"));

    expect(screen.getByTestId("broadcast-confirm-warning")).toBeInTheDocument();
    const posted = mockFetch.mock.calls.filter((c) => c[1]?.method === "POST");
    expect(posted).toHaveLength(0);
  });

  /* "Send to 42 people" is a sentence somebody can decline. "Send to everyone"
     is not, because it does not say how many that is. */
  it("names the real number of recipients in the confirmation", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    await user.type(screen.getByTestId("broadcast-message"), "Office closed Monday.");
    await user.click(screen.getByTestId("broadcast-send"));
    expect(screen.getByTestId("broadcast-confirm")).toHaveTextContent("Yes, send to 42 people");
  });

  it("can be backed out of without sending", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.type(screen.getByTestId("broadcast-message"), "Office closed Monday.");
    await user.click(screen.getByTestId("broadcast-send"));
    await user.click(screen.getByTestId("broadcast-cancel"));
    expect(screen.queryByTestId("broadcast-confirm-warning")).not.toBeInTheDocument();
    expect(mockFetch.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(0);
  });

  it("sends only after the confirmation is taken", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.type(screen.getByTestId("broadcast-message"), "Office closed Monday.");
    await user.click(screen.getByTestId("broadcast-send"));
    await user.click(screen.getByTestId("broadcast-confirm"));
    await waitFor(() =>
      expect(mockFetch.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(1),
    );
  });
});

describe("the outcome is reported as it happened", () => {
  it("reports how many people actually received it", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.type(screen.getByTestId("broadcast-message"), "Hello.");
    await user.click(screen.getByTestId("broadcast-send"));
    await user.click(screen.getByTestId("broadcast-confirm"));
    expect(await screen.findByTestId("broadcast-result")).toHaveTextContent(
      "Delivered to 42 people",
    );
  });

  it("says a partial send was partial, rather than calling it clean", async () => {
    mockFetch.mockImplementation((url: string, init?: { method?: string }) =>
      init?.method ? json({ delivered: 40, failed: 2, redacted: [] }, 207) : json({ recipients: 42, readable: true }),
    );
    const user = userEvent.setup();
    render(<Page />);
    await user.type(screen.getByTestId("broadcast-message"), "Hello.");
    await user.click(screen.getByTestId("broadcast-send"));
    await user.click(screen.getByTestId("broadcast-confirm"));
    expect(await screen.findByTestId("broadcast-result")).toHaveTextContent(
      "2 could not be reached",
    );
  });

  /* THE ONE THAT MATTERS. Nothing was sent, and the page must say so. */
  it("says nothing was sent when the recipient list could not be read", async () => {
    mockFetch.mockImplementation((url: string, init?: { method?: string }) =>
      init?.method
        ? json({ error: "recipients_unreadable" }, 503)
        : json({ recipients: 42, readable: true }),
    );
    const user = userEvent.setup();
    render(<Page />);
    await user.type(screen.getByTestId("broadcast-message"), "Hello.");
    await user.click(screen.getByTestId("broadcast-send"));
    await user.click(screen.getByTestId("broadcast-confirm"));
    expect(await screen.findByTestId("broadcast-error")).toHaveTextContent(/Nothing was sent/);
  });

  /* The text people received is not the text that was typed, and the sender is
     the only person who can judge whether that mattered. */
  it("tells the sender when the message was edited before sending", async () => {
    mockFetch.mockImplementation((url: string, init?: { method?: string }) =>
      init?.method
        ? json({ delivered: 42, failed: 0, redacted: ["card_number"] })
        : json({ recipients: 42, readable: true }),
    );
    const user = userEvent.setup();
    render(<Page />);
    await user.type(screen.getByTestId("broadcast-message"), "Ref 4111111111111111.");
    await user.click(screen.getByTestId("broadcast-send"));
    await user.click(screen.getByTestId("broadcast-confirm"));
    expect(await screen.findByTestId("broadcast-redacted")).toHaveTextContent("card_number");
  });

  /* A stale success banner above a fresh draft is a lie about the new text. */
  it("clears the previous outcome once the sender starts a new message", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.type(screen.getByTestId("broadcast-message"), "Hello.");
    await user.click(screen.getByTestId("broadcast-send"));
    await user.click(screen.getByTestId("broadcast-confirm"));
    await screen.findByTestId("broadcast-result");
    await user.type(screen.getByTestId("broadcast-message"), "Something else.");
    expect(screen.queryByTestId("broadcast-result")).not.toBeInTheDocument();
  });
});

describe("the character limit", () => {
  it("refuses to send an over-length message", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByTestId("broadcast-message"));
    await user.paste("x".repeat(2001));
    expect(screen.getByTestId("broadcast-send")).toBeDisabled();
    expect(screen.getByTestId("broadcast-remaining")).toHaveTextContent("over the limit");
  });
});
