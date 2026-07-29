/**
 * @jest-environment jsdom
 *
 * ReleaseTimeline UI tests: empty state, month-tab navigation (one month shown
 * at a time), year tabs when history spans years, and expand-to-reveal the
 * per-feature "How to use" guidance.
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
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

// Newest-first, as the API returns. Two releases in July 2026 (same month) and
// one in January 2025 (different year) to exercise month + year tabs.
const RELEASES: Release[] = [
  rel({
    id: "r1",
    released_on: "2026-07-29",
    title: "July Late",
    entries: [{ title: "Login fixed", description: "Sign in works", how_to_use: "Just log in normally", category: "fix" }],
  }),
  rel({
    id: "r2",
    released_on: "2026-07-03",
    title: "July Early",
    entries: [{ title: "New dashboard", description: "Fresh home", how_to_use: "Open the Dashboard tab", category: "feature" }],
  }),
  rel({
    id: "r3",
    released_on: "2025-01-10",
    title: "January Release",
    entries: [{ title: "Old thing", description: "d", how_to_use: "Legacy step", category: "improvement" }],
  }),
];

test("renders an empty state when there are no releases", () => {
  render(<ReleaseTimeline releases={[]} />);
  expect(screen.getByTestId("releases-empty")).toBeInTheDocument();
});

test("defaults to the newest year + month and shows only that month", () => {
  render(<ReleaseTimeline releases={RELEASES} />);
  // Year tabs present (spans 2026 + 2025); month tab for July (index 6).
  expect(screen.getByTestId("year-tab-2026")).toBeInTheDocument();
  expect(screen.getByTestId("year-tab-2025")).toBeInTheDocument();
  expect(screen.getByTestId("month-tab-6")).toBeInTheDocument();
  // July releases shown; the January (different year) release is not.
  expect(screen.getByText("July Late")).toBeInTheDocument();
  expect(screen.getByText("July Early")).toBeInTheDocument();
  expect(screen.queryByText("January Release")).not.toBeInTheDocument();
});

test("the newest release in the month is expanded; others are collapsed", () => {
  render(<ReleaseTimeline releases={RELEASES} />);
  expect(screen.getByText("Just log in normally")).toBeInTheDocument(); // July Late (open)
  expect(screen.queryByText("Open the Dashboard tab")).not.toBeInTheDocument(); // July Early (collapsed)
});

test("clicking a collapsed release expands its feature breakdown", () => {
  render(<ReleaseTimeline releases={RELEASES} />);
  fireEvent.click(screen.getByRole("button", { name: /July Early/ }));
  expect(screen.getByText("Open the Dashboard tab")).toBeInTheDocument();
});

test("switching year tab shows that year's month + releases", () => {
  render(<ReleaseTimeline releases={RELEASES} />);
  fireEvent.click(screen.getByTestId("year-tab-2025"));
  expect(screen.getByTestId("month-tab-0")).toBeInTheDocument(); // January
  expect(screen.getByText("January Release")).toBeInTheDocument();
  expect(screen.queryByText("July Late")).not.toBeInTheDocument();
});
