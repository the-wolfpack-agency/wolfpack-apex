/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import TicketList, {
  type SupportTicket,
} from "@/app/(dashboard)/support/_components/TicketList";

jest.mock("next/link", () => {
   
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

  test("audience pill click invokes onAudienceFilterChange and filters the rows", () => {
    const onAudienceFilterChange = jest.fn();
    const tickets = [
      makeTicket({ id: "1", audience: "client" }),
      makeTicket({ id: "2", audience: "internal" }),
      makeTicket({ id: "3", audience: "internal" }),
    ];
    /* Verify the audience pill row exists and counts each bucket. */
    const { rerender } = render(
      <TicketList
        tickets={tickets}
        filter="all"
        onFilterChange={() => {}}
        audienceFilter="all"
        onAudienceFilterChange={onAudienceFilterChange}
      />,
    );
    expect(
      screen.getByTestId("ticket-list-audience-filters"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("ticket-audience-filter-all").textContent,
    ).toMatch(/\(3\)/);
    expect(
      screen.getByTestId("ticket-audience-filter-client").textContent,
    ).toMatch(/\(1\)/);
    expect(
      screen.getByTestId("ticket-audience-filter-internal").textContent,
    ).toMatch(/\(2\)/);

    fireEvent.click(screen.getByTestId("ticket-audience-filter-client"));
    expect(onAudienceFilterChange).toHaveBeenCalledWith("client");

    /* When the parent commits the filter, only matching rows render. */
    rerender(
      <TicketList
        tickets={tickets}
        filter="all"
        onFilterChange={() => {}}
        audienceFilter="client"
        onAudienceFilterChange={onAudienceFilterChange}
      />,
    );
    expect(screen.getByTestId("ticket-row-1")).toBeInTheDocument();
    expect(screen.queryByTestId("ticket-row-2")).toBeNull();
    expect(screen.queryByTestId("ticket-row-3")).toBeNull();
  });

  test("renders the AI '?' indicator when an AI-categorized ticket has low confidence", () => {
    const lowConfidence = makeTicket({
      id: "low",
      category: "billing",
      category_source: "ai",
      category_confidence: 0.55,
    });
    const highConfidence = makeTicket({
      id: "high",
      category: "billing",
      category_source: "ai",
      category_confidence: 0.93,
    });
    const manual = makeTicket({
      id: "manual",
      category: "billing",
      category_source: "manual",
      category_confidence: null,
    });
    render(
      <TicketList
        tickets={[lowConfidence, highConfidence, manual]}
        filter="all"
        onFilterChange={() => {}}
      />,
    );
    expect(
      screen.getByTestId("ticket-row-ai-uncertain-low"),
    ).toBeInTheDocument();
    /* High-confidence AI category does NOT show the indicator. */
    expect(screen.queryByTestId("ticket-row-ai-uncertain-high")).toBeNull();
    /* Manual categorization never shows the indicator. */
    expect(screen.queryByTestId("ticket-row-ai-uncertain-manual")).toBeNull();
  });

  test("each row renders an audience badge whose color matches its value", () => {
    const tickets = [
      makeTicket({ id: "c1", audience: "client" }),
      makeTicket({ id: "i1", audience: "internal" }),
    ];
    render(
      <TicketList
        tickets={tickets}
        filter="all"
        onFilterChange={() => {}}
      />,
    );
    const clientBadge = screen.getByTestId("audience-badge-client");
    const internalBadge = screen.getByTestId("audience-badge-internal");
    expect(clientBadge).toBeInTheDocument();
    expect(internalBadge).toBeInTheDocument();
    /* Client should use the info-blue token; internal should not. */
    expect(clientBadge.style.background).toContain("82, 154, 232");
    expect(internalBadge.style.background).not.toContain("82, 154, 232");
  });
});
