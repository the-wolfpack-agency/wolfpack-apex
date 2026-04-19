/**
 * @jest-environment jsdom
 */

/**
 * SeoHeadInjector — DOM injection contract.
 *
 * Mounts the SeoHeadInjector inside a jsdom document, asserts that the
 * expected `<title>`, `<meta>`, and `<link rel="icon">` children land in
 * `document.head` with the correct content. Verifies:
 *   - title, description, og:image, canonical, robots, favicon all emit.
 *   - re-rendering with a new brief replaces (not duplicates) the tags.
 *   - unmount cleans up the tags it added.
 */

import "@testing-library/jest-dom";
import { render, cleanup } from "@testing-library/react";
import { SeoHeadInjector } from "@/app/sites/[id]/preview/page";
import type { SiteBrief } from "@/lib/sites-schema";

function baseBrief(): SiteBrief {
  return {
    client: "acme",
    product: { name: "Acme", tagline: "We ship" },
    pages: [
      { route: "/", title: "Home", sections: [] },
    ],
    defaultSeo: {
      description: "Default description",
      ogImage: "https://cdn.example.com/og.png",
      canonical: "https://www.acme.com/",
    },
    favicon: { src: "https://cdn.example.com/fav.ico" },
  };
}

function getInjectedTags(): Element[] {
  return Array.from(document.head.querySelectorAll('[data-instinct-seo="1"]'));
}

afterEach(() => {
  cleanup();
  // Purge any stragglers so tests are isolated.
  document
    .querySelectorAll('[data-instinct-seo="1"]')
    .forEach((el) => el.parentElement?.removeChild(el));
});

describe("SeoHeadInjector", () => {
  it("injects title + description + og:image + canonical + icon into document.head", () => {
    render(<SeoHeadInjector brief={baseBrief()} pageIndex={0} />);

    const title = document.head.querySelector<HTMLTitleElement>(
      'title[data-instinct-seo="1"]',
    );
    expect(title?.text).toBe("Acme");

    const desc = document.head.querySelector(
      'meta[data-instinct-seo="1"][name="description"]',
    );
    expect(desc?.getAttribute("content")).toBe("Default description");

    const og = document.head.querySelector(
      'meta[data-instinct-seo="1"][property="og:image"]',
    );
    expect(og?.getAttribute("content")).toBe("https://cdn.example.com/og.png");

    const canonical = document.head.querySelector(
      'link[data-instinct-seo="1"][rel="canonical"]',
    );
    expect(canonical?.getAttribute("href")).toBe("https://www.acme.com/");

    const icon = document.head.querySelector(
      'link[data-instinct-seo="1"][rel="icon"]',
    );
    expect(icon?.getAttribute("href")).toBe("https://cdn.example.com/fav.ico");
  });

  it("emits robots=noindex when the brief asks", () => {
    const brief = baseBrief();
    brief.defaultSeo = { ...brief.defaultSeo, noIndex: true };
    render(<SeoHeadInjector brief={brief} pageIndex={0} />);
    const robots = document.head.querySelector(
      'meta[data-instinct-seo="1"][name="robots"]',
    );
    expect(robots?.getAttribute("content")).toBe("noindex");
  });

  it("does NOT emit robots when noIndex is unset", () => {
    render(<SeoHeadInjector brief={baseBrief()} pageIndex={0} />);
    expect(
      document.head.querySelector(
        'meta[data-instinct-seo="1"][name="robots"]',
      ),
    ).toBeNull();
  });

  it("does nothing when brief is null", () => {
    render(<SeoHeadInjector brief={null} pageIndex={0} />);
    expect(getInjectedTags()).toHaveLength(0);
  });

  it("cleans up its tags on unmount", () => {
    const { unmount } = render(<SeoHeadInjector brief={baseBrief()} pageIndex={0} />);
    expect(getInjectedTags().length).toBeGreaterThan(0);
    unmount();
    expect(getInjectedTags().length).toBe(0);
  });

  it("rerenders without piling up duplicate tags", () => {
    const { rerender } = render(
      <SeoHeadInjector brief={baseBrief()} pageIndex={0} />,
    );
    const firstCount = document.head.querySelectorAll(
      'meta[data-instinct-seo="1"][property="og:type"]',
    ).length;
    // Change the brief identity — injector should drop-then-inject.
    const brief2: SiteBrief = {
      ...baseBrief(),
      product: { name: "Acme v2", tagline: "We ship v2" },
    };
    rerender(<SeoHeadInjector brief={brief2} pageIndex={0} />);
    const ogTypeCount = document.head.querySelectorAll(
      'meta[data-instinct-seo="1"][property="og:type"]',
    ).length;
    // og:type is emitted exactly once per render — not accumulated.
    expect(ogTypeCount).toBe(firstCount);
    const title = document.head.querySelector<HTMLTitleElement>(
      'title[data-instinct-seo="1"]',
    );
    expect(title?.text).toBe("Acme v2");
  });
});
