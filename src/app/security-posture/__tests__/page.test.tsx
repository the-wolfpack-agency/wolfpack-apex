/** @jest-environment jsdom */
import "@testing-library/jest-dom";
/**
 * The public /security-posture page renders the real document, with the
 * Control status table as a real table (header + one row per claim), so each
 * claim reads with its status next to it.
 */
import { render, screen, within } from "@testing-library/react";
import SecurityPosturePage from "../page";
import { POSTURE_CLAIMS, STATUS_WORDS } from "@/lib/compliance/posture-claims";

it("renders the Control status table with one row per claim, status beside it", () => {
  const { container } = render(<SecurityPosturePage />);
  expect(screen.getByRole("heading", { name: "Control status" })).toBeInTheDocument();
  const tables = container.querySelectorAll("table");
  expect(tables.length).toBeGreaterThanOrEqual(3);
  const status = tables[0];
  expect(within(status).getByText("Evidence key")).toBeInTheDocument();
  const rows = status.querySelectorAll("tbody tr");
  expect(rows).toHaveLength(POSTURE_CLAIMS.length);
  for (const c of POSTURE_CLAIMS) {
    const row = Array.from(rows).find((r) => r.textContent?.includes(c.key));
    expect(row).toBeDefined();
    const cells = row!.querySelectorAll("td");
    expect(cells[1].textContent?.startsWith(STATUS_WORDS[c.docStatus])).toBe(true);
  }
});

it("no separator row leaks into the table and no stray pipes render", () => {
  const { container } = render(<SecurityPosturePage />);
  expect(container.textContent).not.toMatch(/\|---/);
  expect(container.querySelector("article")?.innerHTML).not.toMatch(/<tr>\s*<td[^>]*>---/);
});
