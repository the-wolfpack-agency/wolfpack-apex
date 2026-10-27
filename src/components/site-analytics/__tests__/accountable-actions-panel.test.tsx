/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import type { AccountableActionsSummary } from "@/lib/site-analytics-accountability";

import { AccountableActionsPanel } from "@/components/site-analytics/AccountableActionsPanel";

const DATA: AccountableActionsSummary = {
  available: true,
  rangeDays: 30,
  surface: "all",
  totals: { total: 46, browserSession: 40, signedWithin: 2, signedOutside: 1, unaccountable: 3, wouldHold: 4 },
  sites: [
    { site: "instinct", total: 43, browserSession: 40, signedWithin: 0, signedOutside: 0, unaccountable: 3, wouldHold: 3 },
    { site: "ogiam.com", total: 3, browserSession: 0, signedWithin: 2, signedOutside: 1, unaccountable: 0, wouldHold: 1 },
  ],
  heldReasons: [{ reason: "script_client", count: 3 }, { reason: "verified_principal", count: 1 }],
  kinds: [{ kind: "login", count: 30, wouldHold: 2 }],
};

describe("AccountableActionsPanel", () => {
  it("renders per-site counts for each class and the would-hold total", () => {
    render(<AccountableActionsPanel data={DATA} rangeDays={30} />);
    expect(screen.getByTestId("ff-accountable-total")).toHaveTextContent("46");
    expect(screen.getByTestId("ff-accountable-would-hold")).toHaveTextContent("4");
    const cells = within(screen.getByTestId("ff-accountable-site-ogiam.com")).getAllByRole("cell").map((c) => c.textContent);
    expect(cells).toEqual(["ogiam.com", "0", "2", "1", "0", "1"]);
    expect(screen.getByTestId("ff-accountable-reason-script_client")).toHaveTextContent(/script or tool/);
    expect(screen.getByTestId("ff-accountable-reason-verified_principal")).toHaveTextContent(/outside its mandate/);
    expect(screen.getByText(/never held/)).toBeInTheDocument();
    expect(screen.getByText(/last 30d/)).toBeInTheDocument();
  });

  it("shows an explicit empty state when no actions were recorded", () => {
    render(<AccountableActionsPanel data={{ ...DATA, totals: { ...DATA.totals, total: 0, wouldHold: 0 }, sites: [], heldReasons: [], kinds: [] }} rangeDays={30} />);
    expect(screen.getByTestId("ff-accountable-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("ff-accountable-table")).toBeNull();
  });

  it("shows an error, never a zero, when the read failed", () => {
    render(<AccountableActionsPanel data={{ ...DATA, available: false }} rangeDays={30} />);
    expect(screen.getByTestId("ff-accountable-error")).toHaveTextContent(/unknown, not zero/);
    expect(screen.queryByTestId("ff-accountable-total")).toBeNull();
  });

  it("shows the error state when an older API sends no accountability field", () => {
    render(<AccountableActionsPanel data={undefined} rangeDays={7} />);
    expect(screen.getByTestId("ff-accountable-error")).toBeInTheDocument();
  });
});
