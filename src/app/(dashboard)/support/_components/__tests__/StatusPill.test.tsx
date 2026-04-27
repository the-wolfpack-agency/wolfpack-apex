/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import StatusPill, {
  STATUS_LABEL,
  type TicketStatus,
} from "@/app/(dashboard)/support/_components/StatusPill";

describe("<StatusPill />", () => {
  const cases: TicketStatus[] = [
    "open",
    "drafted",
    "sent",
    "resolved",
    "closed",
  ];

  test.each(cases)("renders the correct label for %s", (status) => {
    render(<StatusPill status={status} />);
    const el = screen.getByTestId(`status-pill-${status}`);
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute("data-status", status);
    expect(el.textContent).toContain(STATUS_LABEL[status]);
  });

  test("sent and resolved use the green token", () => {
    const { rerender } = render(<StatusPill status="sent" />);
    expect(screen.getByTestId("status-pill-sent").style.background).toContain(
      "80, 175, 110",
    );
    rerender(<StatusPill status="resolved" />);
    expect(
      screen.getByTestId("status-pill-resolved").style.background,
    ).toContain("80, 175, 110");
  });

  test("open and drafted use the yellow token", () => {
    const { rerender } = render(<StatusPill status="open" />);
    expect(screen.getByTestId("status-pill-open").style.background).toContain(
      "229, 180, 69",
    );
    rerender(<StatusPill status="drafted" />);
    expect(
      screen.getByTestId("status-pill-drafted").style.background,
    ).toContain("229, 180, 69");
  });

  test("each status renders with role=status for assistive tech", () => {
    for (const s of cases) {
      const { unmount } = render(<StatusPill status={s} />);
      expect(screen.getByTestId(`status-pill-${s}`)).toHaveAttribute(
        "role",
        "status",
      );
      unmount();
    }
  });
});
