/**
 * @jest-environment jsdom
 *
 * RagSnapshotBadge — renders exact vs fuzzy labels, formats cache age,
 * conditionally shows the refresh button, and sets correct aria.
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { RagSnapshotBadge } from "@/components/RagSnapshotBadge";

describe("RagSnapshotBadge", () => {
  const NOW = 1_700_000_000_000;

  it("renders 'From snapshot · Nh ago' on an exact hit", () => {
    const cachedAt = NOW - 2 * 60 * 60 * 1000; // 2h old
    render(
      <RagSnapshotBadge
        cachedAtMs={cachedAt}
        isFuzzy={false}
        nowMs={NOW}
      />,
    );
    const badge = screen.getByTestId("rag-snapshot-badge");
    expect(badge).toHaveAttribute("data-mode", "exact");
    expect(screen.getByTestId("rag-snapshot-badge-label")).toHaveTextContent(
      "From snapshot \u00B7 2h ago",
    );
    expect(badge.getAttribute("aria-label")).toContain("Served from cached snapshot");
    expect(badge.getAttribute("aria-label")).toContain("2h ago");
  });

  it("renders 'Similar match · NN% · age' on a fuzzy hit", () => {
    const cachedAt = NOW - 5 * 60 * 1000; // 5m old
    render(
      <RagSnapshotBadge
        cachedAtMs={cachedAt}
        isFuzzy={true}
        similarity={0.733}
        nowMs={NOW}
      />,
    );
    const badge = screen.getByTestId("rag-snapshot-badge");
    expect(badge).toHaveAttribute("data-mode", "fuzzy");
    expect(screen.getByTestId("rag-snapshot-badge-label")).toHaveTextContent(
      "Similar match \u00B7 73% \u00B7 5m ago",
    );
    expect(badge.getAttribute("aria-label")).toContain("Similar cached result");
    expect(badge.getAttribute("aria-label")).toContain("73%");
    expect(badge.getAttribute("aria-label")).toContain("5m ago");
  });

  it("renders 'Similar match · age' when similarity is omitted", () => {
    render(
      <RagSnapshotBadge
        cachedAtMs={NOW - 1000}
        isFuzzy={true}
        nowMs={NOW}
      />,
    );
    expect(screen.getByTestId("rag-snapshot-badge-label")).toHaveTextContent(
      "Similar match \u00B7 just now",
    );
  });

  describe("age formatting", () => {
    it.each([
      [0, "just now"],
      [30_000, "just now"],
      [60_000, "1m ago"],
      [59 * 60_000, "59m ago"],
      [60 * 60_000, "1h ago"],
      [23 * 60 * 60_000, "23h ago"],
      [24 * 60 * 60_000, "1d ago"],
      [3 * 24 * 60 * 60_000, "3d ago"],
    ])("renders %sms as %s", (age, expected) => {
      render(
        <RagSnapshotBadge
          cachedAtMs={NOW - age}
          isFuzzy={false}
          nowMs={NOW}
        />,
      );
      expect(screen.getByTestId("rag-snapshot-badge-label")).toHaveTextContent(
        `From snapshot \u00B7 ${expected}`,
      );
    });

    it("clamps negative age (clock skew) to just now", () => {
      render(
        <RagSnapshotBadge
          cachedAtMs={NOW + 30_000}
          isFuzzy={false}
          nowMs={NOW}
        />,
      );
      expect(screen.getByTestId("rag-snapshot-badge-label")).toHaveTextContent(
        "From snapshot \u00B7 just now",
      );
    });
  });

  describe("refresh button visibility", () => {
    it("hides refresh button when onRefresh is not provided", () => {
      render(
        <RagSnapshotBadge
          cachedAtMs={NOW - 1000}
          isFuzzy={false}
          isOnline={true}
          nowMs={NOW}
        />,
      );
      expect(
        screen.queryByTestId("rag-snapshot-badge-refresh"),
      ).not.toBeInTheDocument();
    });

    it("hides refresh button when offline even if onRefresh is provided", () => {
      const onRefresh = jest.fn();
      render(
        <RagSnapshotBadge
          cachedAtMs={NOW - 1000}
          isFuzzy={false}
          isOnline={false}
          onRefresh={onRefresh}
          nowMs={NOW}
        />,
      );
      expect(
        screen.queryByTestId("rag-snapshot-badge-refresh"),
      ).not.toBeInTheDocument();
    });

    it("hides refresh button when isOnline is unspecified (defensive)", () => {
      const onRefresh = jest.fn();
      render(
        <RagSnapshotBadge
          cachedAtMs={NOW - 1000}
          isFuzzy={false}
          onRefresh={onRefresh}
          nowMs={NOW}
        />,
      );
      expect(
        screen.queryByTestId("rag-snapshot-badge-refresh"),
      ).not.toBeInTheDocument();
    });

    it("shows refresh button when online AND onRefresh provided; fires on click", () => {
      const onRefresh = jest.fn();
      render(
        <RagSnapshotBadge
          cachedAtMs={NOW - 1000}
          isFuzzy={false}
          isOnline={true}
          onRefresh={onRefresh}
          nowMs={NOW}
        />,
      );
      const btn = screen.getByTestId("rag-snapshot-badge-refresh");
      expect(btn).toBeInTheDocument();
      expect(btn).toHaveAttribute("aria-label", "Refresh snapshot");
      fireEvent.click(btn);
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
  });
});
