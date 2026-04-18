/**
 * @jest-environment jsdom
 */

/**
 * render-brief component tests.
 *
 * Hits the shared renderer + every section component directly with
 * React Testing Library, covering the contracts promised to the live
 * preview iframe:
 *   - Every section type renders from a SiteBrief payload.
 *   - Missing optional fields don't throw.
 *   - Multi-page briefs default to page 0; `page={1}` picks the second.
 *   - Zero-page briefs show an empty state instead of blowing up.
 *   - Hero CTA renders an anchor; without CTA, no anchor.
 *   - Cards: N items → N rendered; 0 items → empty state copy.
 *   - User text is escaped (no raw <script> injection).
 *
 * The preview page (which uses `use(params)` suspension) is covered by
 * Playwright E2E + the RenderBrief coverage here. Attempting to mount
 * the preview page in RTL runs into the same Next.js 16 `use(Promise)`
 * scheduler issue documented in sites-detail-ui.test.tsx.
 */

import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import { RenderBrief } from "@/components/sites/render-brief";
import { HeroSection } from "@/components/sites/sections/hero";
import { TextSection } from "@/components/sites/sections/text";
import { CardsSection } from "@/components/sites/sections/cards";
import { GallerySection } from "@/components/sites/sections/gallery";
import { QuoteSection } from "@/components/sites/sections/quote";
import { StatsSection } from "@/components/sites/sections/stats";
import { CalloutSection } from "@/components/sites/sections/callout";
import { BannerSection } from "@/components/sites/sections/banner";
import type { BriefSection, SiteBrief } from "@/lib/sites";

function briefWith(sections: BriefSection[], pages: Array<{ route: string; sections: BriefSection[] }> = []): SiteBrief {
  return {
    client: "acme",
    product: { name: "Acme" },
    pages: pages.length > 0 ? pages : [{ route: "/", sections }],
  };
}

describe("HeroSection", () => {
  it("renders heading, body, and CTA when all fields are present", () => {
    render(
      <HeroSection
        section={{
          type: "hero",
          heading: "Welcome to Acme",
          body: "We build things.",
          cta: { label: "Get started", href: "/signup" },
        }}
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Welcome to Acme" })).toBeInTheDocument();
    expect(screen.getByText("We build things.")).toBeInTheDocument();
    const cta = screen.getByTestId("hero-cta");
    expect(cta).toBeInTheDocument();
    expect(cta.tagName).toBe("A");
    expect(cta).toHaveAttribute("href", "/signup");
    expect(cta).toHaveTextContent("Get started");
  });

  it("renders without CTA (no anchor) when cta is missing", () => {
    render(<HeroSection section={{ type: "hero", heading: "Hi", body: "There" }} />);
    expect(screen.getByRole("heading", { level: 1, name: "Hi" })).toBeInTheDocument();
    expect(screen.queryByTestId("hero-cta")).not.toBeInTheDocument();
  });

  it("renders a minimal placeholder when all fields are missing and does not throw", () => {
    expect(() => render(<HeroSection section={{ type: "hero" }} />)).not.toThrow();
    expect(screen.getByTestId("hero-section")).toBeInTheDocument();
  });

  it("applies backgroundImage as inline style without dangerouslySetInnerHTML", () => {
    const { container } = render(
      <HeroSection
        section={{ type: "hero", heading: "H", backgroundImage: "/bg.jpg" }}
      />,
    );
    const section = container.querySelector("[data-testid='hero-section']") as HTMLElement;
    expect(section.style.backgroundImage).toContain("/bg.jpg");
  });
});

describe("TextSection", () => {
  it("renders heading + body", () => {
    render(
      <TextSection section={{ type: "text", heading: "About", body: "Some body copy." }} />,
    );
    expect(screen.getByRole("heading", { name: "About" })).toBeInTheDocument();
    expect(screen.getByText("Some body copy.")).toBeInTheDocument();
  });

  it("renders without throwing when heading/body absent", () => {
    expect(() => render(<TextSection section={{ type: "text" }} />)).not.toThrow();
    expect(screen.getByTestId("text-section")).toBeInTheDocument();
  });
});

describe("CardsSection", () => {
  it("renders N cards for N items", () => {
    render(
      <CardsSection
        section={{
          type: "cards",
          heading: "Services",
          items: [
            { title: "One", body: "first" },
            { title: "Two", body: "second" },
            { title: "Three", body: "third", accent: true, badge: "NEW" },
          ],
        }}
      />,
    );
    const items = screen.getAllByTestId("cards-item");
    expect(items).toHaveLength(3);
    expect(items[2]).toHaveTextContent("NEW");
    expect(items[2]).toHaveTextContent("Three");
  });

  it("renders an empty state when items is absent", () => {
    render(<CardsSection section={{ type: "cards", heading: "Empty" }} />);
    expect(screen.getByTestId("cards-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("cards-item")).not.toBeInTheDocument();
  });

  it("renders an empty state when items is an empty array", () => {
    render(<CardsSection section={{ type: "cards", items: [] }} />);
    expect(screen.getByTestId("cards-empty")).toBeInTheDocument();
  });

  it("handles items with partial fields without throwing", () => {
    expect(() =>
      render(
        <CardsSection
          section={{
            type: "cards",
            items: [{}, { title: "Only title" }, { body: "Only body" }],
          }}
        />,
      ),
    ).not.toThrow();
    expect(screen.getAllByTestId("cards-item")).toHaveLength(3);
  });
});

describe("GallerySection", () => {
  it("renders both string and object image shapes", () => {
    render(
      <GallerySection
        section={{
          type: "gallery",
          images: ["/a.jpg", { src: "/b.jpg", alt: "B" }],
        }}
      />,
    );
    const items = screen.getAllByTestId("gallery-item");
    expect(items).toHaveLength(2);
    const imgs = items.flatMap((i) => Array.from(i.querySelectorAll("img")));
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual(["/a.jpg", "/b.jpg"]);
  });

  it("renders empty state when images is missing", () => {
    expect(() => render(<GallerySection section={{ type: "gallery" }} />)).not.toThrow();
    expect(screen.getByTestId("gallery-empty")).toBeInTheDocument();
  });

  it("skips empty string entries without throwing", () => {
    render(
      <GallerySection section={{ type: "gallery", images: ["", "/ok.jpg", { src: "" }] }} />,
    );
    expect(screen.getAllByTestId("gallery-item")).toHaveLength(1);
  });
});

describe("QuoteSection", () => {
  it("renders body + attribution", () => {
    render(
      <QuoteSection
        section={{ type: "quote", body: "The only way out is through.", attribution: "Frost" }}
      />,
    );
    expect(screen.getByText("The only way out is through.")).toBeInTheDocument();
    expect(screen.getByText(/Frost/)).toBeInTheDocument();
  });

  it("renders body alone without throwing", () => {
    expect(() =>
      render(<QuoteSection section={{ type: "quote", body: "Only body." }} />),
    ).not.toThrow();
    expect(screen.getByText("Only body.")).toBeInTheDocument();
  });

  it("renders placeholder with neither body nor attribution", () => {
    expect(() => render(<QuoteSection section={{ type: "quote" }} />)).not.toThrow();
    expect(screen.getByTestId("quote-section")).toBeInTheDocument();
  });
});

describe("StatsSection", () => {
  it("renders N stats with prefix/suffix applied", () => {
    render(
      <StatsSection
        section={{
          type: "stats",
          heading: "By the numbers",
          items: [
            { label: "Years", value: 12, suffix: "+" },
            { label: "Deals", value: 1000, prefix: "$" },
          ],
        }}
      />,
    );
    const items = screen.getAllByTestId("stats-item");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("12+");
    expect(items[1]).toHaveTextContent("$1,000");
  });

  it("renders empty state when items missing", () => {
    expect(() => render(<StatsSection section={{ type: "stats" }} />)).not.toThrow();
    expect(screen.getByTestId("stats-empty")).toBeInTheDocument();
  });

  it("handles items without value without throwing", () => {
    expect(() =>
      render(
        <StatsSection
          section={{ type: "stats", items: [{ label: "x", value: undefined as unknown as number }] }}
        />,
      ),
    ).not.toThrow();
  });
});

describe("CalloutSection", () => {
  it("renders heading, body, and CTA", () => {
    render(
      <CalloutSection
        section={{
          type: "callout",
          heading: "Heads up",
          body: "Read this.",
          cta: { label: "Docs", href: "/docs" },
        }}
      />,
    );
    expect(screen.getByText("Heads up")).toBeInTheDocument();
    expect(screen.getByText("Read this.")).toBeInTheDocument();
    const cta = screen.getByTestId("callout-cta");
    expect(cta).toHaveAttribute("href", "/docs");
  });

  it("no CTA → no anchor; still renders body", () => {
    render(<CalloutSection section={{ type: "callout", body: "just body" }} />);
    expect(screen.queryByTestId("callout-cta")).not.toBeInTheDocument();
    expect(screen.getByText("just body")).toBeInTheDocument();
  });

  it("empty section renders placeholder, no throw", () => {
    expect(() => render(<CalloutSection section={{ type: "callout" }} />)).not.toThrow();
    expect(screen.getByTestId("callout-section")).toBeInTheDocument();
  });
});

describe("BannerSection", () => {
  it("renders heading + body + CTA", () => {
    render(
      <BannerSection
        section={{
          type: "banner",
          heading: "CHAMPION",
          body: "Year one.",
          cta: { label: "Partner", href: "/contact" },
        }}
      />,
    );
    expect(screen.getByText("CHAMPION")).toBeInTheDocument();
    expect(screen.getByText("Year one.")).toBeInTheDocument();
    expect(screen.getByTestId("banner-cta")).toHaveAttribute("href", "/contact");
  });

  it("renders with only heading; no throw on missing body/CTA", () => {
    expect(() => render(<BannerSection section={{ type: "banner", heading: "BIG" }} />)).not.toThrow();
    expect(screen.getByText("BIG")).toBeInTheDocument();
  });

  it("empty banner renders a placeholder, no throw", () => {
    expect(() => render(<BannerSection section={{ type: "banner" }} />)).not.toThrow();
    expect(screen.getByTestId("banner-section")).toBeInTheDocument();
  });
});

describe("RenderBrief — page selection + escaping", () => {
  it("defaults to page 0 when `page` prop omitted", () => {
    const brief = briefWith([], [
      { route: "/", sections: [{ type: "text", heading: "Page A", body: "" }] },
      { route: "/two", sections: [{ type: "text", heading: "Page B", body: "" }] },
    ]);
    render(<RenderBrief brief={brief} />);
    expect(screen.getByText("Page A")).toBeInTheDocument();
    expect(screen.queryByText("Page B")).not.toBeInTheDocument();
  });

  it("renders the second page when page={1}", () => {
    const brief = briefWith([], [
      { route: "/", sections: [{ type: "text", heading: "Page A", body: "" }] },
      { route: "/two", sections: [{ type: "text", heading: "Page B", body: "" }] },
    ]);
    render(<RenderBrief brief={brief} page={1} />);
    expect(screen.getByText("Page B")).toBeInTheDocument();
    expect(screen.queryByText("Page A")).not.toBeInTheDocument();
  });

  it("falls back to page 0 when index is out of range", () => {
    const brief = briefWith([], [
      { route: "/", sections: [{ type: "text", heading: "Only Page" }] },
    ]);
    render(<RenderBrief brief={brief} page={99} />);
    expect(screen.getByText("Only Page")).toBeInTheDocument();
  });

  it("renders an empty state when pages is empty — does not throw", () => {
    const brief: SiteBrief = { client: "acme", product: { name: "Acme" }, pages: [] };
    expect(() => render(<RenderBrief brief={brief} />)).not.toThrow();
    expect(screen.getByTestId("render-brief-empty")).toBeInTheDocument();
  });

  it("renders every section type on a single page without throwing", () => {
    const brief = briefWith([
      { type: "hero", heading: "Hero here", body: "body" },
      { type: "text", heading: "Text", body: "body" },
      { type: "cards", heading: "Cards", items: [{ title: "c1" }] },
      { type: "gallery", images: ["/g.jpg"] },
      { type: "quote", body: "q", attribution: "me" },
      { type: "stats", items: [{ label: "L", value: 1 }] },
      { type: "callout", body: "c" },
      { type: "banner", heading: "B" },
    ]);
    expect(() => render(<RenderBrief brief={brief} />)).not.toThrow();
    expect(screen.getByTestId("hero-section")).toBeInTheDocument();
    expect(screen.getByTestId("text-section")).toBeInTheDocument();
    expect(screen.getByTestId("cards-section")).toBeInTheDocument();
    expect(screen.getByTestId("gallery-section")).toBeInTheDocument();
    expect(screen.getByTestId("quote-section")).toBeInTheDocument();
    expect(screen.getByTestId("stats-section")).toBeInTheDocument();
    expect(screen.getByTestId("callout-section")).toBeInTheDocument();
    expect(screen.getByTestId("banner-section")).toBeInTheDocument();
  });

  it("escapes raw HTML in section heading (never injects <script>)", () => {
    const brief = briefWith([
      { type: "hero", heading: "<script>alert(1)</script>", body: "safe" },
    ]);
    const { container } = render(<RenderBrief brief={brief} />);
    const hero = container.querySelector("[data-testid='hero-section']") as HTMLElement;
    // Assert no actual <script> child element was injected.
    expect(hero.querySelector("script")).toBeNull();
    // The text content is preserved (React escapes into text nodes).
    expect(hero).toHaveTextContent("<script>alert(1)</script>");
    // innerHTML should contain the escaped form, NOT a literal <script>
    // tag that the browser would execute.
    const html = hero.innerHTML;
    expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("renders without throwing when a page has no sections", () => {
    const brief = briefWith([], [{ route: "/", sections: [] }]);
    expect(() => render(<RenderBrief brief={brief} />)).not.toThrow();
    // The page-level empty state copy renders.
    expect(screen.getByText(/no sections yet/i)).toBeInTheDocument();
  });

  it("marks the root with the selected page route for debugability", () => {
    const brief = briefWith([], [
      { route: "/", sections: [{ type: "text", heading: "A" }] },
      { route: "/about", sections: [{ type: "text", heading: "B" }] },
    ]);
    const { container } = render(<RenderBrief brief={brief} page={1} />);
    const root = container.querySelector("[data-testid='render-brief']") as HTMLElement;
    expect(root).toHaveAttribute("data-page-route", "/about");
    expect(within(root).getByText("B")).toBeInTheDocument();
  });
});
