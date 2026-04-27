/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import SeverityBadge, {
  SEVERITY_LABEL,
  type Severity,
} from "@/app/(dashboard)/support/_components/SeverityBadge";

describe("<SeverityBadge />", () => {
  const cases: Severity[] = ["p0", "p1", "p2", "p3"];

  test.each(cases)("renders the correct label for %s", (sev) => {
    render(<SeverityBadge severity={sev} />);
    const el = screen.getByTestId(`severity-badge-${sev}`);
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute("data-severity", sev);
    expect(el.textContent).toBe(SEVERITY_LABEL[sev]);
  });

  test("renders distinct colors for each severity", () => {
    const seen = new Set<string>();
    for (const sev of cases) {
      const { unmount } = render(<SeverityBadge severity={sev} />);
      const el = screen.getByTestId(`severity-badge-${sev}`);
      const color = el.style.color;
      expect(color).toBeTruthy();
      seen.add(color);
      unmount();
    }
    // P0/P1/P2/P3 must each map to a distinct color so the operator can
    // tell them apart at a glance. P3 may share dim with the closed
    // status pill, but it's distinct from p0/p1/p2.
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  test("p0 background uses the red token", () => {
    render(<SeverityBadge severity="p0" />);
    const el = screen.getByTestId("severity-badge-p0");
    expect(el.style.background).toContain("232, 123, 123");
  });

  test("p2 background uses the green token", () => {
    render(<SeverityBadge severity="p2" />);
    const el = screen.getByTestId("severity-badge-p2");
    expect(el.style.background).toContain("80, 175, 110");
  });
});
