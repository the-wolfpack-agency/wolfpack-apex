/**
 * @jest-environment jsdom
 *
 * ReleaseTimeline UI tests: empty state, the analytics strip, month-tab
 * navigation (one month at a time), year tabs across years, expand-to-reveal
 * how-to-use, and the Products (creation-milestone) view.
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import ReleaseTimeline from "@/components/releases/ReleaseTimeline";
import type { Release } from "@/lib/releases";

function rel(over: Partial<Release>): Release {
  return {
    id: over.id ?? "r",
    version: over.version ?? "v",
    title: over.title ?? "Title",
    summary: over.summary ?? "",
    released_on: over.released_on ?? "2026-07-29",
    entries: over.entries ?? [],
    published: true,
    created_by: null,
    created_at: "",
    updated_at: "",
    ...over,
  };
}

const MILESTONE = rel({
  id: "m1",
  version: "instinct-created",
  title: "Instinct created",
  released_on: "2026-04-05",
  entries: [{ title: "Instinct project created", description: "", how_to_use: "", area: "Instinct", category: "milestone", loc: 50000 }],
});

const RELEASES: Release[] = [
  rel({ id: "r1", released_on: "2026-07-29", title: "July Late", entries: [{ title: "Login fixed", description: "Sign in works", how_to_use: "Just log in normally", category: "fix" }] }),
  rel({ id: "r2", released_on: "2026-07-03", title: "July Early", entries: [{ title: "New dashboard", description: "Fresh home", how_to_use: "Open the Dashboard tab", category: "feature" }] }),
  rel({ id: "r3", released_on: "2025-01-10", title: "January Release", entries: [{ title: "Old thing", description: "d", how_to_use: "Legacy step", category: "improvement" }] }),
  MILESTONE,
];

test("renders an empty state when there are no releases", () => {
  render(<ReleaseTimeline releases={[]} />);
  expect(screen.getByTestId("releases-empty")).toBeInTheDocument();
});

test("shows an analytics strip with product, LOC, release and feature totals", () => {
  render(<ReleaseTimeline releases={RELEASES} />);
  const stats = screen.getByTestId("releases-stats");
  expect(stats).toBeInTheDocument();
  expect(screen.getByText("Lines of code")).toBeInTheDocument();
  expect(screen.getByText("~50,000")).toBeInTheDocument(); // sum of milestone loc
  expect(screen.getByText("Features shipped")).toBeInTheDocument();
  // "Products" appears in both the stat label and the view toggle; assert it's
  // present in the stats strip specifically.
  expect(within(stats).getByText("Products")).toBeInTheDocument();
});

test("Releases view defaults to newest month; milestones excluded from it", () => {
  render(<ReleaseTimeline releases={RELEASES} />);
  expect(screen.getByTestId("month-tab-6")).toBeInTheDocument(); // July
  expect(screen.getByText("July Late")).toBeInTheDocument();
  expect(screen.getByText("July Early")).toBeInTheDocument();
  expect(screen.queryByText("January Release")).not.toBeInTheDocument(); // different year
  expect(screen.queryByText("Instinct created")).not.toBeInTheDocument(); // milestone lives in Products view
});

test("newest release in the month is expanded; clicking a collapsed one expands it", () => {
  render(<ReleaseTimeline releases={RELEASES} />);
  expect(screen.getByText("Just log in normally")).toBeInTheDocument();
  expect(screen.queryByText("Open the Dashboard tab")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /July Early/ }));
  expect(screen.getByText("Open the Dashboard tab")).toBeInTheDocument();
});

test("year tab switches the visible year", () => {
  render(<ReleaseTimeline releases={RELEASES} />);
  fireEvent.click(screen.getByTestId("year-tab-2025"));
  expect(screen.getByTestId("month-tab-0")).toBeInTheDocument(); // January
  expect(screen.getByText("January Release")).toBeInTheDocument();
  expect(screen.queryByText("July Late")).not.toBeInTheDocument();
});

test("Products view lists creation milestones and hides the month tabs", () => {
  render(<ReleaseTimeline releases={RELEASES} />);
  fireEvent.click(screen.getByTestId("view-products"));
  expect(screen.getByTestId("products-timeline")).toBeInTheDocument();
  expect(screen.getByText("Instinct")).toBeInTheDocument(); // milestone product name
  expect(screen.queryByTestId("month-tab-6")).not.toBeInTheDocument();
});

/**
 * The headline number and the snapshot it comes from must agree.
 *
 * Reported from production: the tile read ~1,802,656 while the snapshot
 * published the same day read 1,828,902. The tile was summing creation
 * milestones, which are frozen at each product's first commit and never move.
 * Two different numbers for the same thing on one screen is worse than either
 * being wrong, because the reader stops trusting both.
 */
const SNAPSHOT = rel({
  id: "s1",
  version: "loc-snapshot-2026-08-02",
  title: "Codebase snapshot: 1,828,902 lines",
  released_on: "2026-08-02",
  entries: [
    { title: "AgenticQA", description: "", how_to_use: "", area: "AgenticQA", category: "milestone", loc: 698251 },
    { title: "Instinct", description: "", how_to_use: "", area: "Instinct", category: "milestone", loc: 641537 },
  ],
});

test("the lines-of-code tile equals the newest snapshot, not the frozen milestones", () => {
  render(<ReleaseTimeline releases={[MILESTONE, SNAPSHOT]} />);
  // 698,251 + 641,537, NOT the milestone's 50,000.
  expect(screen.getByText("1,339,788")).toBeInTheDocument();
  expect(screen.queryByText(/50,000/)).not.toBeInTheDocument();
});

test("an exact snapshot is not prefixed with a tilde", () => {
  // The tilde is what invited the mismatch to look like rounding.
  render(<ReleaseTimeline releases={[MILESTONE, SNAPSHOT]} />);
  expect(screen.queryByText("~1,339,788")).not.toBeInTheDocument();
});

test("the newest snapshot wins when there are several", () => {
  const older = rel({
    id: "s0",
    version: "loc-snapshot-2026-07-01",
    released_on: "2026-07-01",
    entries: [{ title: "x", description: "", how_to_use: "", area: "Instinct", category: "milestone", loc: 111 }],
  });
  render(<ReleaseTimeline releases={[older, SNAPSHOT]} />);
  expect(screen.getByText("1,339,788")).toBeInTheDocument();
});

test("without any snapshot it still falls back to the creation milestones", () => {
  render(<ReleaseTimeline releases={[MILESTONE]} />);
  expect(screen.getByText("~50,000")).toBeInTheDocument();
});

test("snapshot rows are not counted as shipped features", () => {
  // Otherwise measuring the codebase would report seven things shipped.
  const { container } = render(<ReleaseTimeline releases={[SNAPSHOT]} />);
  expect(container.textContent).not.toMatch(/\b2\s+FEATURES/i);
});
