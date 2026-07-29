/**
 * @jest-environment jsdom
 *
 * ReleaseTimeline UI tests: empty state, rendering, the year-tab date filter,
 * and expand-to-reveal the per-feature "How to use" guidance.
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

const RELEASES: Release[] = [
  rel({
    id: "r1",
    version: "2026-07-29",
    title: "July Release",
    summary: "Summer improvements",
    released_on: "2026-07-29",
    entries: [{ title: "Login fixed", description: "You can sign in again", how_to_use: "Just log in normally", category: "fix" }],
  }),
  rel({
    id: "r2",
    version: "2025-01-10",
    title: "January Release",
    summary: "Winter features",
    released_on: "2025-01-10",
    entries: [{ title: "New dashboard", description: "A fresh home screen", how_to_use: "Open the Dashboard tab", category: "feature" }],
  }),
];

test("renders an empty state when there are no releases", () => {
  render(<ReleaseTimeline releases={[]} />);
  expect(screen.getByTestId("releases-empty")).toBeInTheDocument();
});

test("renders every release with year tabs for date filtering", () => {
  render(<ReleaseTimeline releases={RELEASES} />);
  expect(screen.getByText("July Release")).toBeInTheDocument();
  expect(screen.getByText("January Release")).toBeInTheDocument();
  expect(screen.getByTestId("year-tab-all")).toBeInTheDocument();
  expect(screen.getByTestId("year-tab-2026")).toBeInTheDocument();
  expect(screen.getByTestId("year-tab-2025")).toBeInTheDocument();
});

test("the newest release is expanded by default and shows its How-to-use", () => {
  render(<ReleaseTimeline releases={RELEASES} />);
  // Newest (July) open by default.
  expect(screen.getByText("Just log in normally")).toBeInTheDocument();
  // Older (January) collapsed, so its how-to-use is not rendered yet.
  expect(screen.queryByText("Open the Dashboard tab")).not.toBeInTheDocument();
});

test("clicking a collapsed release expands its feature breakdown", () => {
  render(<ReleaseTimeline releases={RELEASES} />);
  fireEvent.click(screen.getByRole("button", { name: /January Release/ }));
  expect(screen.getByText("Open the Dashboard tab")).toBeInTheDocument();
});

test("year tab filters releases by date", () => {
  render(<ReleaseTimeline releases={RELEASES} />);
  fireEvent.click(screen.getByTestId("year-tab-2025"));
  expect(screen.queryByText("July Release")).not.toBeInTheDocument();
  expect(screen.getByText("January Release")).toBeInTheDocument();
});
