/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import TicketThread, {
  formatRelativeTime,
  type TicketMessage,
} from "@/app/(dashboard)/support/_components/TicketThread";

function msg(overrides: Partial<TicketMessage> = {}): TicketMessage {
  return {
    id: "m-1",
    ticket_id: "tkt-1",
    direction: "inbound",
    from_email: "user@example.com",
    body: "Hello support team, please help with my login.",
    received_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    ...overrides,
  };
}

describe("<TicketThread />", () => {
  test("empty state renders the friendly placeholder", () => {
    render(<TicketThread thread={[]} />);
    expect(screen.getByTestId("ticket-thread-empty").textContent).toMatch(
      /No messages on this ticket yet/,
    );
    expect(screen.queryByTestId("ticket-thread-list")).not.toBeInTheDocument();
  });

  test("two-message thread renders both with correct direction badges", () => {
    const inbound = msg({
      id: "m-in",
      direction: "inbound",
      from_email: "customer@x.com",
      body: "Original inbound email body.",
    });
    const outbound = msg({
      id: "m-out",
      direction: "outbound",
      from_email: "support@thewolfpack.agency",
      body: "Operator reply.",
    });

    render(<TicketThread thread={[inbound, outbound]} />);

    const items = screen.getAllByTestId("ticket-thread-message");
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute("data-direction")).toBe("inbound");
    expect(items[1].getAttribute("data-direction")).toBe("outbound");

    const badges = screen.getAllByTestId("ticket-thread-direction-badge");
    expect(badges[0].textContent).toMatch(/Inbound/);
    expect(badges[1].textContent).toMatch(/Outbound/);

    const fromLines = screen.getAllByTestId("ticket-thread-from");
    expect(fromLines[0].textContent).toBe("customer@x.com");
    expect(fromLines[1].textContent).toBe("support@thewolfpack.agency");
  });

  test("Show more expands long messages", () => {
    const longBody = "A".repeat(700);
    render(<TicketThread thread={[msg({ body: longBody })]} />);

    const body = screen.getByTestId("ticket-thread-body");
    /* Truncated rendering should be 500 chars + ellipsis. */
    expect(body.textContent?.length).toBeLessThan(longBody.length);
    expect(body.textContent?.endsWith("…")).toBe(true);

    const toggle = screen.getByTestId("ticket-thread-toggle");
    expect(toggle.textContent).toBe("Show more");

    fireEvent.click(toggle);

    const bodyAfter = screen.getByTestId("ticket-thread-body");
    expect(bodyAfter.textContent).toBe(longBody);
    expect(screen.getByTestId("ticket-thread-toggle").textContent).toBe(
      "Show less",
    );
  });

  test("relative-time renders the right bucket", () => {
    const now = Date.now();

    expect(formatRelativeTime(new Date(now - 5_000).toISOString(), now)).toBe(
      "just now",
    );
    expect(formatRelativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe(
      "5m ago",
    );
    expect(
      formatRelativeTime(new Date(now - 3 * 60 * 60_000).toISOString(), now),
    ).toBe("3h ago");
    expect(
      formatRelativeTime(new Date(now - 4 * 24 * 60 * 60_000).toISOString(), now),
    ).toBe("4d ago");

    /* Render path also surfaces the relative time. */
    render(
      <TicketThread
        thread={[
          msg({
            id: "m-time",
            received_at: new Date(now - 90 * 60_000).toISOString(),
          }),
        ]}
      />,
    );
    expect(screen.getByTestId("ticket-thread-time").textContent).toBe("1h ago");
  });
});
