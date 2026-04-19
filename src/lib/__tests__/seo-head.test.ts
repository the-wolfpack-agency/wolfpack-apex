/**
 * seo-head — unit tests for the per-page head-tag builder.
 *
 * Covers the full fallback chain:
 *   title       → page.seo.title | brief.defaultSeo.title | product.name
 *   description → page.seo.description | defaultSeo.description | product.tagline
 *   ogImage     → page.seo.ogImage | defaultSeo.ogImage
 *   canonical   → page.seo.canonical | defaultSeo.canonical
 *   noIndex     → page.seo.noIndex | defaultSeo.noIndex
 *   favicon     → briefToFaviconHref(brief)
 *
 * Also covers:
 *   - og:type is always emitted on any valid brief.
 *   - empty-brief / zero-pages returns [].
 *   - build fn does NOT truncate oversize strings — that's validateBrief's
 *     job. The builder trusts the validated shape.
 *   - relative ogImage/canonical get resolved against previewUrl.
 */

import { buildSeoMetaTags, type SeoMetaTag } from "@/lib/seo-head";
import type { SiteBrief } from "@/lib/sites-schema";

function mkBrief(overrides: Partial<SiteBrief> = {}): SiteBrief {
  return {
    client: "acme",
    product: { name: "Acme", tagline: "We ship." },
    pages: [
      { route: "/", title: "Home", sections: [{ type: "hero", heading: "Hi" }] },
    ],
    ...overrides,
  };
}

function findTag(
  tags: SeoMetaTag[],
  predicate: (t: SeoMetaTag) => boolean,
): SeoMetaTag | undefined {
  return tags.find(predicate);
}

describe("buildSeoMetaTags — fallback chain", () => {
  it("title prefers page.seo.title over defaults and product.name", () => {
    const tags = buildSeoMetaTags({
      brief: mkBrief({
        defaultSeo: { title: "Default Title" },
        pages: [
          {
            route: "/",
            sections: [],
            seo: { title: "Page Title" },
          },
        ],
      }),
      pageIndex: 0,
    });
    const title = findTag(tags, (t) => t.tag === "title");
    expect(title?.attrs.text).toBe("Page Title");
  });

  it("title falls through page → default → product.name", () => {
    const tags = buildSeoMetaTags({
      brief: mkBrief({
        defaultSeo: { title: "Default Title" },
      }),
      pageIndex: 0,
    });
    expect(findTag(tags, (t) => t.tag === "title")?.attrs.text).toBe("Default Title");
  });

  it("title ultimate fallback is product.name", () => {
    const tags = buildSeoMetaTags({
      brief: mkBrief(),
      pageIndex: 0,
    });
    expect(findTag(tags, (t) => t.tag === "title")?.attrs.text).toBe("Acme");
  });

  it("description falls through to product.tagline", () => {
    const tags = buildSeoMetaTags({
      brief: mkBrief(),
      pageIndex: 0,
    });
    const desc = findTag(
      tags,
      (t) => t.tag === "meta" && t.attrs.name === "description",
    );
    expect(desc?.attrs.content).toBe("We ship.");
  });

  it("omits description when neither seo nor tagline is set", () => {
    const tags = buildSeoMetaTags({
      brief: mkBrief({ product: { name: "Acme" } }),
      pageIndex: 0,
    });
    expect(findTag(tags, (t) => t.attrs.name === "description")).toBeUndefined();
  });

  it("emits og:image when ogImage present; omits when absent", () => {
    const withOg = buildSeoMetaTags({
      brief: mkBrief({
        defaultSeo: { ogImage: "https://cdn.example.com/og.png" },
      }),
      pageIndex: 0,
    });
    expect(
      findTag(withOg, (t) => t.attrs.property === "og:image")?.attrs.content,
    ).toBe("https://cdn.example.com/og.png");

    const withoutOg = buildSeoMetaTags({ brief: mkBrief(), pageIndex: 0 });
    expect(findTag(withoutOg, (t) => t.attrs.property === "og:image")).toBeUndefined();
  });

  it("emits robots noindex when noIndex true", () => {
    const tags = buildSeoMetaTags({
      brief: mkBrief({ defaultSeo: { noIndex: true } }),
      pageIndex: 0,
    });
    expect(
      findTag(tags, (t) => t.attrs.name === "robots")?.attrs.content,
    ).toBe("noindex");
  });

  it("omits robots noindex when not set", () => {
    const tags = buildSeoMetaTags({ brief: mkBrief(), pageIndex: 0 });
    expect(findTag(tags, (t) => t.attrs.name === "robots")).toBeUndefined();
  });

  it("page-level noIndex overrides default noIndex even when page value is false", () => {
    const tags = buildSeoMetaTags({
      brief: mkBrief({
        defaultSeo: { noIndex: true },
        pages: [
          {
            route: "/",
            sections: [],
            seo: { noIndex: false },
          },
        ],
      }),
      pageIndex: 0,
    });
    expect(findTag(tags, (t) => t.attrs.name === "robots")).toBeUndefined();
  });

  it("emits canonical when set", () => {
    const tags = buildSeoMetaTags({
      brief: mkBrief({
        defaultSeo: { canonical: "https://www.acme.com/" },
      }),
      pageIndex: 0,
    });
    const link = findTag(tags, (t) => t.tag === "link" && t.attrs.rel === "canonical");
    expect(link?.attrs.href).toBe("https://www.acme.com/");
  });

  it("always emits og:type=website on any valid brief", () => {
    const tags = buildSeoMetaTags({ brief: mkBrief(), pageIndex: 0 });
    expect(
      findTag(tags, (t) => t.attrs.property === "og:type")?.attrs.content,
    ).toBe("website");
  });

  it("favicon link emitted when src is set", () => {
    const tags = buildSeoMetaTags({
      brief: mkBrief({ favicon: { src: "https://cdn.example.com/fav.ico" } }),
      pageIndex: 0,
    });
    const link = findTag(tags, (t) => t.tag === "link" && t.attrs.rel === "icon");
    expect(link?.attrs.href).toBe("https://cdn.example.com/fav.ico");
  });

  it("favicon link emitted as data URL when autoGenerate", () => {
    const tags = buildSeoMetaTags({
      brief: mkBrief({ favicon: { autoGenerate: true } }),
      pageIndex: 0,
    });
    const link = findTag(tags, (t) => t.tag === "link" && t.attrs.rel === "icon");
    expect(link?.attrs.href.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(link?.attrs.type).toBe("image/svg+xml");
  });

  it("favicon link omitted when no favicon config", () => {
    const tags = buildSeoMetaTags({ brief: mkBrief(), pageIndex: 0 });
    expect(findTag(tags, (t) => t.tag === "link" && t.attrs.rel === "icon")).toBeUndefined();
  });

  it("returns [] on brief with zero pages", () => {
    expect(
      buildSeoMetaTags({
        brief: { client: "x", product: { name: "X" }, pages: [] },
        pageIndex: 0,
      }),
    ).toEqual([]);
  });

  it("defaults applied when page.seo missing entirely", () => {
    const tags = buildSeoMetaTags({
      brief: mkBrief({
        defaultSeo: {
          title: "Site Default",
          description: "A site-wide description",
          ogImage: "https://cdn.example.com/og.png",
        },
      }),
      pageIndex: 0,
    });
    expect(findTag(tags, (t) => t.tag === "title")?.attrs.text).toBe("Site Default");
    expect(
      findTag(tags, (t) => t.attrs.name === "description")?.attrs.content,
    ).toBe("A site-wide description");
    expect(
      findTag(tags, (t) => t.attrs.property === "og:image")?.attrs.content,
    ).toBe("https://cdn.example.com/og.png");
  });

  it("does NOT truncate oversize title — trusts the validator", () => {
    // Build fn is a pure mapper; if an oversize value slips past the
    // validator (e.g. manual DB edit), the tag emits it verbatim rather
    // than silently lying about the content.
    const giantTitle = "y".repeat(100);
    const tags = buildSeoMetaTags({
      brief: mkBrief({
        pages: [{ route: "/", sections: [], seo: { title: giantTitle } }],
      }),
      pageIndex: 0,
    });
    expect(findTag(tags, (t) => t.tag === "title")?.attrs.text).toBe(giantTitle);
  });

  it("clamps pageIndex out-of-range to the first page", () => {
    const tags = buildSeoMetaTags({
      brief: mkBrief({
        pages: [
          { route: "/", sections: [], seo: { title: "Home" } },
        ],
      }),
      pageIndex: 99,
    });
    expect(findTag(tags, (t) => t.tag === "title")?.attrs.text).toBe("Home");
  });

  it("resolves a relative ogImage against previewUrl when provided", () => {
    const tags = buildSeoMetaTags({
      brief: mkBrief({ defaultSeo: { ogImage: "/og.png" } }),
      pageIndex: 0,
      previewUrl: "https://preview.instinct.dev",
    });
    expect(
      findTag(tags, (t) => t.attrs.property === "og:image")?.attrs.content,
    ).toBe("https://preview.instinct.dev/og.png");
  });

  it("leaves already-absolute URLs alone even when previewUrl is set", () => {
    const tags = buildSeoMetaTags({
      brief: mkBrief({ defaultSeo: { ogImage: "https://cdn.example.com/og.png" } }),
      pageIndex: 0,
      previewUrl: "https://preview.instinct.dev",
    });
    expect(
      findTag(tags, (t) => t.attrs.property === "og:image")?.attrs.content,
    ).toBe("https://cdn.example.com/og.png");
  });
});
