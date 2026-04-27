/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import TicketList, {
  type SupportTicket,
} from "@/app/(dashboard)/support/_components/TicketList";

jest.mock("next/link", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  return ({ href, children, ...rest }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  );
});

function makeTicket(overrides: Partial<SupportTicket> = {}): SupportTicket {
  return {
    id: "tkt_1",
    title: "User can't log in",
    body: "AADSTS20012 error on every login",
    category: "m365",
    severity: "p1",
    status: "drafted",
    draft_response: "Try reconnecting Outlook…",
    drafted_at: new Date(Date.now() - 4 * 60_000).toISOString(),
    created_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    matched_patterns: ["AADSTS20012 WS-Fed troubleshooting"],
    ...overrides,
  };
}

describe("<TicketList />", () => {
  test("renders the empty state when there are no tickets", () => {
    render(
      <TicketList
        tickets={[]}
        filter="all"
        onFilterChange={() => {}}
      />,
    );
    expect(screen.getByTestId("ticket-list-empty")).toBeInTheDocument();
    expect(screen.getByTestId("ticket-list-empty").textContent).toMatch(
      /No tickets yet/,
    );
    // Filter pill counts should all be 0.
    expect(screen.getByTestId("ticket-filter-all").textContent).toMatch(/\(0\)/);
  });

  test("renders one row per ticket and shows the activity line", () => {
    const t = makeTicket();
    render(
      <TicketList
        tickets={[t]}
        filter="all"
        onFilterChange={() => {}}
      />,
    );
    expect(screen.getByTestId(`ticket-row-${t.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`ticket-row-${t.id}`).textContent).toMatch(
      /User can't log in/,
    );
    expect(
      screen.getByTestId(`ticket-row-activity-${t.id}`).textContent,
    ).toMatch(/Drafted/);
  });

  test("clicking a filter pill calls onFilterChange with the new key", () => {
    const onFilterChange = jest.fn();
    render(
      <TicketList
        tickets={[]}
        filter="all"
        onFilterChange={onFilterChange}
      />,
    );
    fireEvent.click(screen.getByTestId("ticket-filter-drafted"));
    expect(onFilterChange).toHaveBeenCalledWith("drafted");
  });

  test("clicking a row navigates to /support/[id] via the overlay link", () => {
    const t = makeTicket({ id: "tkt_42" });
    render(
      <TicketList
        tickets={[t]}
        filter="all"
        onFilterChange={() => {}}
      />,
    );
    const link = screen.getByTestId(`ticket-row-link-${t.id}`);
    expect(link.getAttribute("href")).toBe("/support/tkt_42");
  });

  test("filter pills show counts derived from the ticket array", () => {
    const tickets: SupportTicket[] = [
      makeTicket({ id: "1", status: "open" }),
      makeTicket({ id: "2", status: "open" }),
      makeTicket({ id: "3", status: "drafted" }),
      makeTicket({ id: "4", status: "sent" }),
      makeTicket({ id: "5", status: "resolved" }),
      makeTicket({ id: "6", status: "closed" }),
    ];
    render(
      <TicketList
        tickets={tickets}
        filter="all"
        onFilterChange={() => {}}
      />,
    );
    expect(screen.getByTestId("ticket-filter-all").textContent).toMatch(/\(6\)/);
    expect(screen.getByTestId("ticket-filter-open").textContent).toMatch(
      /\(2\)/,
    );
    expect(screen.getByTestId("ticket-filter-drafted").textContent).toMatch(
      /\(1\)/,
    );
    expect(screen.getByTestId("ticket-filter-sent").textContent).toMatch(
      /\(1\)/,
    );
    // Resolved bucket is the union of resolved + closed.
    expect(screen.getByTestId("ticket-filter-resolved").textContent).toMatch(
      /\(2\)/,
    );
  });

  test("renders the loading state when loading=true", () => {
    render(
      <TicketList
        tickets={[]}
        filter="all"
        onFilterChange={() => {}}
        loading
      />,
    );
    expect(screen.getByTestId("ticket-list-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("ticket-list-empty")).toBeNull();
  });

  test("renders the error state when error is set", () => {
    render(
      <TicketList
        tickets={[]}
        filter="all"
        onFilterChange={() => {}}
        error="Connection lost"
      />,
    );
    expect(screen.getByTestId("ticket-list-error").textContent).toMatch(
      /Connection lost/,
    );
  });
});
