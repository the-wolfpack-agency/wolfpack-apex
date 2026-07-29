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
