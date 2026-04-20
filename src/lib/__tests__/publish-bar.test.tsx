/**
 * @jest-environment jsdom
 */

/**
 * PublishBar — component tests.
 *
 * Covers:
 *   - countBriefDiff: 0 when identical, N for N leaf changes, handles
 *     null/undefined parity, arrays, nested objects.
 *   - Renders breadcrumb / pending-count / last-deploy / publish button.
 *   - Publish button is disabled when pending_count=0 OR when
 *     deployStatus ∈ {saving, deploying}.
 *   - Click publish fires onPublish + onAnalyticsPublishClicked with
 *     the current pending count.
 *   - aria-label of publish button matches the pending count state.
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import PublishBar, { countBriefDiff } from "@/components/sites/PublishBar";

describe("countBriefDiff — deep JSON leaf-diff count", () => {
  it("returns 0 for identical references", () => {
    const a = { x: 1, y: [1, 2] };
    expect(countBriefDiff(a, a)).toBe(0);
  });

  it("returns 0 for deeply-equal values", () => {
    expect(countBriefDiff({ x: 1, y: [1, 2] }, { x: 1, y: [1, 2] })).toBe(0);
  });

  it("returns 1 for a single replaced leaf", () => {
    expect(countBriefDiff({ x: "a" }, { x: "b" })).toBe(1);
  });

  it("returns >=2 for multiple differing leaves", () => {
    const n = countBriefDiff(
      { x: "a", y: "b" },
      { x: "A", y: "B" },
    );
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it("handles null / undefined parity", () => {
    expect(countBriefDiff(null, null)).toBe(0);
    expect(countBriefDiff({ x: 1 }, null)).toBe(1);
  });

  it("handles arrays with length mismatch", () => {
    expect(countBriefDiff([1, 2, 3], [1, 2])).toBeGreaterThanOrEqual(1);
  });

  it("detects nested changes inside arrays of objects", () => {
    expect(
      countBriefDiff(
        [{ title: "a" }, { title: "b" }],
        [{ title: "a" }, { title: "X" }],
      ),
    ).toBe(1);
  });
});

describe("PublishBar — render + wiring", () => {
  function mk(overrides: Partial<React.ComponentProps<typeof PublishBar>> = {}) {
    const onPublish = jest.fn();
    const onAnalyticsPublishClicked = jest.fn();
    const utils = render(
      <PublishBar
        siteName="Acme"
        siteId="site_1"
        clientSlug="acme"
        currentBrief={{ a: 1 }}
        lastPublishedBrief={{ a: 1 }}
        onPublish={onPublish}
        onAnalyticsPublishClicked={onAnalyticsPublishClicked}
        {...overrides}
      />,
    );
    return { ...utils, onPublish, onAnalyticsPublishClicked };
  }

  it("renders breadcrumb, site name, and pending count", () => {
    mk();
    expect(screen.getByTestId("studio-publish-bar")).toBeInTheDocument();
    expect(screen.getByTestId("studio-publish-bar-breadcrumb")).toBeInTheDocument();
    expect(screen.getByTestId("studio-publish-bar-site-name")).toHaveTextContent("Acme");
    expect(screen.getByTestId("studio-publish-bar-pending-count")).toHaveTextContent(
      /in sync/i,
    );
  });

  it("counts pending edits and surfaces the count in the aria-live region", () => {
    mk({
      currentBrief: { a: 1, b: 2 },
      lastPublishedBrief: { a: 1, b: 1 },
    });
    expect(screen.getByTestId("studio-publish-bar-pending-count")).toHaveTextContent(
      "1 edit pending",
    );
  });

  it("disables Publish when in-sync", () => {
    mk();
    const btn = screen.getByTestId("studio-publish-bar-publish-btn");
    expect(btn).toBeDisabled();
    expect(btn.getAttribute("aria-label")).toMatch(/no changes/i);
  });

  it("disables Publish while deploy is in flight even when dirty", () => {
    mk({
      currentBrief: { a: 2 },
      lastPublishedBrief: { a: 1 },
      deployStatus: "deploying",
    });
    expect(screen.getByTestId("studio-publish-bar-publish-btn")).toBeDisabled();
  });

  it("click Publish fires onPublish + onAnalyticsPublishClicked with pending count", () => {
    const { onPublish, onAnalyticsPublishClicked } = mk({
      currentBrief: { a: "x", b: "y" },
      lastPublishedBrief: { a: "X", b: "Y" },
    });
    const btn = screen.getByTestId("studio-publish-bar-publish-btn");
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onAnalyticsPublishClicked).toHaveBeenCalledWith(2);
    expect(onPublish).toHaveBeenCalledWith(2);
  });

  it("renders an 'Open ↗' link when a previewUrl is provided", () => {
    mk({ previewUrl: "https://preview.example.com" });
    const link = screen.getByTestId("studio-publish-bar-open-preview");
    expect(link.getAttribute("href")).toBe("https://preview.example.com");
  });
});
