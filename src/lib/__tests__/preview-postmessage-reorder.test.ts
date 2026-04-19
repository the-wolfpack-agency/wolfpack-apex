/**
 * Pure tests for `applyInlineReorder` + the section.reorder message
 * variant in the postMessage protocol (Path C Phase 2 · Stream Q1).
 *
 * Zero DOM, zero React — this is the contract every other layer builds
 * on. If reordering corrupts the brief or ignores a same-index drop we
 * lose client data silently, so every edge case gets a test.
 */

import {
  INSTINCT_EDIT_ORIGIN,
  applyInlineEdit,
  applyInlineReorder,
  isInstinctEditMessage,
  type InlineEditMessage,
} from "@/lib/preview-postmessage";
import type { SiteBrief } from "@/lib/sites-schema";

function baseBrief(): SiteBrief {
  return {
    client: "acme",
    product: { name: "Acme", tagline: "We ship stuff" },
    theme: { colors: { primary: "#111" } },
    pages: [
      {
        route: "/",
        sections: [
          { type: "hero", heading: "Hero H", body: "Hero B" },
          { type: "text", heading: "Text H", body: "Text B" },
          { type: "testimonial", items: [{ quote: "Great", authorName: "A" }] },
          { type: "pricing", items: [{ name: "Pro", price: "$99" }] },
        ],
      },
      {
        route: "/about",
        sections: [
          { type: "hero", heading: "About" },
          { type: "text", heading: "More" },
        ],
      },
    ],
  };
}

function reorderMsg(args: {
  pageIndex: number;
  fromIndex: number;
  toIndex: number;
}): Extract<InlineEditMessage, { type: "section.reorder" }> {
  return {
    origin: INSTINCT_EDIT_ORIGIN,
    type: "section.reorder",
    pageIndex: args.pageIndex,
    fromIndex: args.fromIndex,
    toIndex: args.toIndex,
  };
}

describe("applyInlineReorder — happy paths", () => {
  it("moves hero from index 0 → 2, sections array matches expected order", () => {
    const brief = baseBrief();
    const next = applyInlineReorder(
      brief,
      reorderMsg({ pageIndex: 0, fromIndex: 0, toIndex: 2 }),
    );
    expect(next).not.toBe(brief);
    const types = next.pages[0].sections.map((s) => s.type);
    expect(types).toEqual(["text", "testimonial", "hero", "pricing"]);
  });

  it("moves last section to index 0 (move up)", () => {
    const brief = baseBrief();
    const next = applyInlineReorder(
      brief,
      reorderMsg({ pageIndex: 0, fromIndex: 3, toIndex: 0 }),
    );
    const types = next.pages[0].sections.map((s) => s.type);
    expect(types).toEqual(["pricing", "hero", "text", "testimonial"]);
  });

  it("moves a middle section one slot down", () => {
    const brief = baseBrief();
    const next = applyInlineReorder(
      brief,
      reorderMsg({ pageIndex: 0, fromIndex: 1, toIndex: 2 }),
    );
    const types = next.pages[0].sections.map((s) => s.type);
    expect(types).toEqual(["hero", "testimonial", "text", "pricing"]);
  });

  it("reordering page 1 does not touch page 0", () => {
    const brief = baseBrief();
    const next = applyInlineReorder(
      brief,
      reorderMsg({ pageIndex: 1, fromIndex: 0, toIndex: 1 }),
    );
    expect(next.pages[0].sections.map((s) => s.type)).toEqual([
      "hero",
      "text",
      "testimonial",
      "pricing",
    ]);
    expect(next.pages[1].sections.map((s) => s.type)).toEqual(["text", "hero"]);
  });
});

describe("applyInlineReorder — no-ops & invalid input", () => {
  it("same-index reorder returns the ORIGINAL brief unchanged (ref equal)", () => {
    const brief = baseBrief();
    const next = applyInlineReorder(
      brief,
      reorderMsg({ pageIndex: 0, fromIndex: 1, toIndex: 1 }),
    );
    expect(next).toBe(brief);
  });

  it("invalid pageIndex → original brief unchanged", () => {
    const brief = baseBrief();
    const next = applyInlineReorder(
      brief,
      reorderMsg({ pageIndex: 99, fromIndex: 0, toIndex: 1 }),
    );
    expect(next).toBe(brief);
  });

  it("negative pageIndex → original brief unchanged", () => {
    const brief = baseBrief();
    const next = applyInlineReorder(
      brief,
      reorderMsg({ pageIndex: -1, fromIndex: 0, toIndex: 1 }),
    );
    expect(next).toBe(brief);
  });

  it("invalid fromIndex (out of range) → original brief unchanged", () => {
    const brief = baseBrief();
    const next = applyInlineReorder(
      brief,
      reorderMsg({ pageIndex: 0, fromIndex: 42, toIndex: 0 }),
    );
    expect(next).toBe(brief);
  });

  it("invalid toIndex (out of range) → original brief unchanged", () => {
    const brief = baseBrief();
    const next = applyInlineReorder(
      brief,
      reorderMsg({ pageIndex: 0, fromIndex: 0, toIndex: 42 }),
    );
    expect(next).toBe(brief);
  });

  it("negative fromIndex → original brief unchanged", () => {
    const brief = baseBrief();
    const next = applyInlineReorder(
      brief,
      reorderMsg({ pageIndex: 0, fromIndex: -1, toIndex: 0 }),
    );
    expect(next).toBe(brief);
  });
});

describe("applyInlineReorder — immutability + preservation", () => {
  it("does NOT mutate the input brief", () => {
    const brief = baseBrief();
    const snapshot = JSON.stringify(brief);
    applyInlineReorder(
      brief,
      reorderMsg({ pageIndex: 0, fromIndex: 0, toIndex: 3 }),
    );
    expect(JSON.stringify(brief)).toBe(snapshot);
  });

  it("preserves product, theme, client, and unrelated pages", () => {
    const brief = baseBrief();
    const next = applyInlineReorder(
      brief,
      reorderMsg({ pageIndex: 0, fromIndex: 0, toIndex: 1 }),
    );
    expect(next.client).toBe(brief.client);
    expect(next.product).toEqual(brief.product);
    expect(next.theme).toEqual(brief.theme);
    expect(next.pages[1]).toEqual(brief.pages[1]);
  });

  it("preserves the moved section's content (heading/body/items)", () => {
    const brief = baseBrief();
    const originalTestimonial = brief.pages[0].sections[2];
    const next = applyInlineReorder(
      brief,
      reorderMsg({ pageIndex: 0, fromIndex: 2, toIndex: 0 }),
    );
    // Deep equality — the moved section must arrive byte-for-byte at its
    // new home, not a half-shallow copy that loses nested items.
    expect(next.pages[0].sections[0]).toEqual(originalTestimonial);
  });
});

describe("applyInlineEdit — section.reorder dispatch", () => {
  it("applyInlineEdit routes section.reorder through applyInlineReorder", () => {
    const brief = baseBrief();
    const next = applyInlineEdit(
      brief,
      reorderMsg({ pageIndex: 0, fromIndex: 0, toIndex: 2 }),
    );
    const types = next.pages[0].sections.map((s) => s.type);
    expect(types).toEqual(["text", "testimonial", "hero", "pricing"]);
  });
});

describe("isInstinctEditMessage — section.reorder validation", () => {
  it("accepts a well-formed section.reorder message", () => {
    expect(
      isInstinctEditMessage({
        origin: INSTINCT_EDIT_ORIGIN,
        type: "section.reorder",
        pageIndex: 0,
        fromIndex: 0,
        toIndex: 2,
      }),
    ).toBe(true);
  });

  it("rejects section.reorder missing indices", () => {
    expect(
      isInstinctEditMessage({
        origin: INSTINCT_EDIT_ORIGIN,
        type: "section.reorder",
        pageIndex: 0,
        fromIndex: 0,
      }),
    ).toBe(false);
  });

  it("rejects section.reorder with non-integer indices", () => {
    expect(
      isInstinctEditMessage({
        origin: INSTINCT_EDIT_ORIGIN,
        type: "section.reorder",
        pageIndex: 0,
        fromIndex: "0",
        toIndex: 2,
      }),
    ).toBe(false);
    expect(
      isInstinctEditMessage({
        origin: INSTINCT_EDIT_ORIGIN,
        type: "section.reorder",
        pageIndex: 0,
        fromIndex: 0.5,
        toIndex: 2,
      }),
    ).toBe(false);
  });

  it("rejects section.reorder with negative indices", () => {
    expect(
      isInstinctEditMessage({
        origin: INSTINCT_EDIT_ORIGIN,
        type: "section.reorder",
        pageIndex: 0,
        fromIndex: -1,
        toIndex: 0,
      }),
    ).toBe(false);
  });

  it("rejects section.reorder without our origin brand", () => {
    expect(
      isInstinctEditMessage({
        origin: "evil.channel",
        type: "section.reorder",
        pageIndex: 0,
        fromIndex: 0,
        toIndex: 1,
      }),
    ).toBe(false);
  });

  it("accepts same-index reorder at protocol level (applyInlineReorder decides no-op)", () => {
    // Same-index is allowed on the wire — the edit page's listener uses
    // `applyInlineReorder`'s ref-equal no-op to short-circuit. Rejecting
    // it here would mean keyboard boundary presses silently disappeared.
    expect(
      isInstinctEditMessage({
        origin: INSTINCT_EDIT_ORIGIN,
        type: "section.reorder",
        pageIndex: 0,
        fromIndex: 2,
        toIndex: 2,
      }),
    ).toBe(true);
  });
});
