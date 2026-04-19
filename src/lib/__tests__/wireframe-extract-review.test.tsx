/**
 * @jest-environment jsdom
 */

/**
 * WireframeExtractReview — mount tests.
 *
 * Verifies:
 *   - Palette swatches render with the correct hex background per slot.
 *   - Apply button invokes onApply with the brief + theme merged.
 *   - Dismiss button invokes onDismiss.
 *   - Both buttons fire analytics via fetchWithRefresh (stubbed fetch).
 *   - `site.wireframe_review_shown` fires once on mount.
 *   - Buttons are keyboard-reachable and carry aria-labels.
 *   - The review card exposes `data-testid` markers for Playwright.
 */

import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";

import WireframeExtractReview, {
  type WireframeExtractPayload,
} from "@/components/sites/WireframeExtractReview";
import type { SiteBrief } from "@/lib/sites-schema";

// The component posts analytics through fetchWithRefresh, which calls
// the global fetch. Stub it per test so we can assert events fired.
let fetchSpy: jest.Mock;
beforeEach(() => {
  // Minimal fetch Response stand-in (ts-jest's jsdom env doesn't ship a
  // real Response constructor). fetchWithRefresh only reads `.status`
  // on the happy path, but we keep the shape complete for safety.
  fetchSpy = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
    text: async () => JSON.stringify({ ok: true }),
    headers: new Headers({ "content-type": "application/json" }),
  } as unknown as Response));
  (global as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;
  // Token so fetchWithRefresh emits an Authorization header — not required
  // by the spy, but matches the real runtime shape.
  window.localStorage.setItem("instinct_token", "test-token");
});

afterEach(() => {
  window.localStorage.clear();
});

function makePayload(overrides: Partial<WireframeExtractPayload> = {}): WireframeExtractPayload {
  const brief: SiteBrief = {
    client: "acme-co",
    product: { name: "Acme", tagline: "Doing acme things." },
    pages: [
      {
        route: "/",
        title: "Home",
        sections: [
          { type: "hero", heading: "Welcome" },
          { type: "cards", heading: "Features" },
          { type: "testimonial", heading: "Love" },
        ],
      },
    ],
  };
  return {
    brief,
    source: "vision",
    metadata: {
      extractedColors: ["#112233", "#445566", "#778899", "#aabbcc", "#ddeeff"],
      detectedFont: "Inter",
      confidence: 0.88,
      latencyMs: 9400,
      generationId: "gen_abc123",
    },
    ...overrides,
  };
}

function analyticsEvents(): string[] {
  return fetchSpy.mock.calls
    .filter(([url]) => url === "/api/analytics")
    .map(([, init]) => JSON.parse((init as RequestInit).body as string).event as string);
}

describe("WireframeExtractReview — mount tests", () => {
  it("renders the five palette swatches with the correct hex background", () => {
    const payload = makePayload();
    render(
      <WireframeExtractReview payload={payload} onApply={jest.fn()} onDismiss={jest.fn()} />,
    );
    // Each slot — primary/accent/bg/fg/muted — renders with a data-color
    // attribute matching the server's extractedColors in order.
    const expected: Record<string, string> = {
      primary: "#112233",
      accent: "#445566",
      bg: "#778899",
      fg: "#aabbcc",
      muted: "#ddeeff",
    };
    for (const [slot, hex] of Object.entries(expected)) {
      const swatch = screen.getByTestId(`wireframe-color-swatch-${slot}`);
      expect(swatch).toHaveAttribute("data-color", hex);
      // The user-visible hex label is uppercase so Max/Meghan can copy it.
      expect(swatch.textContent).toContain(hex.toUpperCase());
    }
  });

  it("falls back to neutral defaults when the server returns too few colors", () => {
    const payload = makePayload({ metadata: { extractedColors: ["#112233"] } });
    render(
      <WireframeExtractReview payload={payload} onApply={jest.fn()} onDismiss={jest.fn()} />,
    );
    // Primary uses the returned color; remaining slots fall back to the
    // neutral palette (hex values; exact match not important — just that
    // they're valid hex strings, not empty).
    expect(screen.getByTestId("wireframe-color-swatch-primary")).toHaveAttribute(
      "data-color",
      "#112233",
    );
    for (const slot of ["accent", "bg", "fg", "muted"]) {
      const attr = screen.getByTestId(`wireframe-color-swatch-${slot}`).getAttribute("data-color");
      expect(attr).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("shows detected font + section count with detected types", () => {
    render(
      <WireframeExtractReview
        payload={makePayload()}
        onApply={jest.fn()}
        onDismiss={jest.fn()}
      />,
    );
    const fontCell = screen.getByTestId("wireframe-detected-font");
    expect(fontCell.textContent).toContain("Inter");
    const sectionCell = screen.getByTestId("wireframe-section-count");
    expect(sectionCell.textContent).toContain("3 sections");
    expect(sectionCell.textContent).toMatch(/hero/);
    expect(sectionCell.textContent).toMatch(/cards/);
  });

  it("falls back to 'Default font' copy when no font was detected", () => {
    const payload = makePayload({ metadata: { extractedColors: [], detectedFont: "" } });
    render(
      <WireframeExtractReview payload={payload} onApply={jest.fn()} onDismiss={jest.fn()} />,
    );
    expect(screen.getByTestId("wireframe-detected-font").textContent).toContain("Default font");
  });

  it("Apply invokes onApply with the brief + theme merged, and fires analytics", async () => {
    const onApply = jest.fn();
    render(
      <WireframeExtractReview payload={makePayload()} onApply={onApply} onDismiss={jest.fn()} />,
    );
    await act(async () => {
      screen.getByTestId("wireframe-apply-btn").click();
      await Promise.resolve();
    });
    expect(onApply).toHaveBeenCalledTimes(1);
    const merged = onApply.mock.calls[0][0];
    // Brief carries the theme under brief.theme so BriefForm picks it up.
    expect(merged.brief.client).toBe("acme-co");
    expect(merged.theme.colors).toEqual({
      primary: "#112233",
      accent: "#445566",
      bg: "#778899",
      fg: "#aabbcc",
      muted: "#ddeeff",
    });
    expect(merged.theme.font?.family).toBe("Inter");
    // Analytics: review_shown fires on mount, review_applied on click.
    expect(analyticsEvents()).toEqual(
      expect.arrayContaining(["site.wireframe_review_shown", "site.wireframe_review_applied"]),
    );
  });

  it("Dismiss invokes onDismiss and fires site.wireframe_review_dismissed", async () => {
    const onDismiss = jest.fn();
    render(
      <WireframeExtractReview
        payload={makePayload()}
        onApply={jest.fn()}
        onDismiss={onDismiss}
      />,
    );
    await act(async () => {
      screen.getByTestId("wireframe-dismiss-btn").click();
      await Promise.resolve();
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(analyticsEvents()).toContain("site.wireframe_review_dismissed");
  });

  it("buttons are tab-reachable and carry descriptive aria-labels", () => {
    render(
      <WireframeExtractReview
        payload={makePayload()}
        onApply={jest.fn()}
        onDismiss={jest.fn()}
      />,
    );
    const apply = screen.getByTestId("wireframe-apply-btn");
    const dismiss = screen.getByTestId("wireframe-dismiss-btn");
    // Default button tabIndex is 0, meaning Tab reaches them.
    expect(apply.tabIndex).toBe(0);
    expect(dismiss.tabIndex).toBe(0);
    expect(apply).toHaveAttribute("aria-label", expect.stringMatching(/apply/i));
    expect(dismiss).toHaveAttribute("aria-label", expect.stringMatching(/edit/i));
  });

  it("exposes the Playwright data-testid surface", () => {
    render(
      <WireframeExtractReview
        payload={makePayload()}
        onApply={jest.fn()}
        onDismiss={jest.fn()}
      />,
    );
    expect(screen.getByTestId("wireframe-extract-review")).toBeInTheDocument();
    expect(screen.getByTestId("wireframe-apply-btn")).toBeInTheDocument();
    expect(screen.getByTestId("wireframe-dismiss-btn")).toBeInTheDocument();
    for (const slot of ["primary", "accent", "bg", "fg", "muted"]) {
      expect(screen.getByTestId(`wireframe-color-swatch-${slot}`)).toBeInTheDocument();
    }
  });
});
