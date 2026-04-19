/**
 * Pure tests for the preview <-> edit postMessage protocol.
 *
 * No DOM, no React — just isInstinctEditMessage + applyInlineEdit. These
 * are the two functions that MUST be bulletproof: they decide whether
 * third-party messages get trusted and whether inline edits mutate the
 * brief. A regression here silently breaks direct-manipulation across
 * every surface that uses the preview iframe.
 */

import {
  INSTINCT_EDIT_ORIGIN,
  applyInlineEdit,
  buildTestimonialEditMessage,
  encodeBriefPush,
  isInstinctEditMessage,
  MAX_POSTMESSAGE_BYTES,
  type InlineEditMessage,
} from "@/lib/preview-postmessage";
import type { SiteBrief } from "@/lib/sites-schema";

function baseBrief(): SiteBrief {
  return {
    client: "acme",
    product: { name: "Acme", tagline: "We ship stuff" },
    pages: [
      {
        route: "/",
        sections: [
          { type: "hero", heading: "Hero H", body: "Hero B", cta: { label: "Go", href: "/go" } },
          { type: "text", heading: "Text H", body: "Text B" },
          { type: "quote", body: "Pull quote", attribution: "— N.H." },
          {
            type: "testimonial",
            items: [
              { quote: "Q1", authorName: "A1", authorTitle: "CEO" },
              { quote: "Q2", authorName: "A2" },
            ],
          },
        ],
      },
    ],
  };
}

describe("isInstinctEditMessage", () => {
  it("rejects non-objects, nulls, primitives", () => {
    expect(isInstinctEditMessage(null)).toBe(false);
    expect(isInstinctEditMessage(undefined)).toBe(false);
    expect(isInstinctEditMessage("text.edit")).toBe(false);
    expect(isInstinctEditMessage(42)).toBe(false);
  });

  it("rejects objects without our origin brand", () => {
    expect(
      isInstinctEditMessage({ origin: "other.channel", type: "text.edit" }),
    ).toBe(false);
    expect(isInstinctEditMessage({ type: "text.edit" })).toBe(false);
  });

  it("accepts a valid ready message", () => {
    expect(
      isInstinctEditMessage({ origin: INSTINCT_EDIT_ORIGIN, type: "ready" }),
    ).toBe(true);
  });

  it("accepts a valid text.edit with heading field", () => {
    expect(
      isInstinctEditMessage({
        origin: INSTINCT_EDIT_ORIGIN,
        type: "text.edit",
        pageIndex: 0,
        sectionIndex: 0,
        field: "heading",
        value: "New",
      }),
    ).toBe(true);
  });

  it("rejects text.edit with an unknown field", () => {
    expect(
      isInstinctEditMessage({
        origin: INSTINCT_EDIT_ORIGIN,
        type: "text.edit",
        pageIndex: 0,
        sectionIndex: 0,
        field: "not-a-field",
        value: "New",
      }),
    ).toBe(false);
  });

  it("rejects text.edit missing numeric indices", () => {
    expect(
      isInstinctEditMessage({
        origin: INSTINCT_EDIT_ORIGIN,
        type: "text.edit",
        pageIndex: "0",
        sectionIndex: 0,
        field: "heading",
        value: "New",
      }),
    ).toBe(false);
  });

  it("accepts a valid cta.edit label + rejects unknown field", () => {
    expect(
      isInstinctEditMessage({
        origin: INSTINCT_EDIT_ORIGIN,
        type: "cta.edit",
        pageIndex: 0,
        sectionIndex: 0,
        field: "label",
        value: "Book now",
      }),
    ).toBe(true);
    expect(
      isInstinctEditMessage({
        origin: INSTINCT_EDIT_ORIGIN,
        type: "cta.edit",
        pageIndex: 0,
        sectionIndex: 0,
        field: "icon",
        value: "x",
      }),
    ).toBe(false);
  });

  it("accepts brief.push with any brief shape (validation is downstream)", () => {
    expect(
      isInstinctEditMessage({
        origin: INSTINCT_EDIT_ORIGIN,
        type: "brief.push",
        brief: { anything: true },
      }),
    ).toBe(true);
    expect(
      isInstinctEditMessage({
        origin: INSTINCT_EDIT_ORIGIN,
        type: "brief.push",
      }),
    ).toBe(false);
  });

  it("accepts hover with section type", () => {
    expect(
      isInstinctEditMessage({
        origin: INSTINCT_EDIT_ORIGIN,
        type: "hover",
        pageIndex: 0,
        sectionIndex: 2,
        sectionType: "hero",
      }),
    ).toBe(true);
  });
});

describe("applyInlineEdit — text.edit", () => {
  it("updates hero heading and returns a NEW brief (immutable)", () => {
    const brief = baseBrief();
    const next = applyInlineEdit(brief, {
      origin: INSTINCT_EDIT_ORIGIN,
      type: "text.edit",
      pageIndex: 0,
      sectionIndex: 0,
      field: "heading",
      value: "New Hero",
    });
    expect(next.pages[0].sections[0].heading).toBe("New Hero");
    // Original must be untouched.
    expect(brief.pages[0].sections[0].heading).toBe("Hero H");
    expect(next).not.toBe(brief);
  });

  it("updates hero body", () => {
    const brief = baseBrief();
    const next = applyInlineEdit(brief, {
      origin: INSTINCT_EDIT_ORIGIN,
      type: "text.edit",
      pageIndex: 0,
      sectionIndex: 0,
      field: "body",
      value: "New body copy",
    });
    expect(next.pages[0].sections[0].body).toBe("New body copy");
  });

  it("updates hero tagline on product (not on section)", () => {
    const brief = baseBrief();
    const next = applyInlineEdit(brief, {
      origin: INSTINCT_EDIT_ORIGIN,
      type: "text.edit",
      pageIndex: 0,
      sectionIndex: 0,
      field: "tagline",
      value: "We ship faster now",
    });
    expect(next.product.tagline).toBe("We ship faster now");
  });

  it("updates quote section body via `quote` field", () => {
    const brief = baseBrief();
    const next = applyInlineEdit(brief, {
      origin: INSTINCT_EDIT_ORIGIN,
      type: "text.edit",
      pageIndex: 0,
      sectionIndex: 2,
      field: "quote",
      value: "Better pull quote",
    });
    expect(next.pages[0].sections[2].body).toBe("Better pull quote");
  });

  it("updates quote section attribution", () => {
    const brief = baseBrief();
    const next = applyInlineEdit(brief, {
      origin: INSTINCT_EDIT_ORIGIN,
      type: "text.edit",
      pageIndex: 0,
      sectionIndex: 2,
      field: "attribution",
      value: "— Nick H",
    });
    expect(next.pages[0].sections[2].attribution).toBe("— Nick H");
  });

  it("updates a testimonial item quote via itemIndex", () => {
    const brief = baseBrief();
    const msg = buildTestimonialEditMessage({
      pageIndex: 0,
      sectionIndex: 3,
      itemIndex: 1,
      field: "quote",
      value: "Updated testimonial",
    });
    const next = applyInlineEdit(brief, msg);
    expect(next.pages[0].sections[3].items?.[1].quote).toBe(
      "Updated testimonial",
    );
    // Sibling item untouched.
    expect(next.pages[0].sections[3].items?.[0].quote).toBe("Q1");
  });

  it("updates a testimonial item authorName via attribution field", () => {
    const brief = baseBrief();
    const msg = buildTestimonialEditMessage({
      pageIndex: 0,
      sectionIndex: 3,
      itemIndex: 0,
      field: "attribution",
      value: "Nick H.",
    });
    const next = applyInlineEdit(brief, msg);
    expect(next.pages[0].sections[3].items?.[0].authorName).toBe("Nick H.");
    // authorTitle preserved.
    expect(next.pages[0].sections[3].items?.[0].authorTitle).toBe("CEO");
  });

  it("preserves sibling fields on the same section", () => {
    const brief = baseBrief();
    const next = applyInlineEdit(brief, {
      origin: INSTINCT_EDIT_ORIGIN,
      type: "text.edit",
      pageIndex: 0,
      sectionIndex: 0,
      field: "heading",
      value: "Only heading changed",
    });
    expect(next.pages[0].sections[0].body).toBe("Hero B");
    expect(next.pages[0].sections[0].cta?.label).toBe("Go");
  });
});

describe("applyInlineEdit — cta.edit", () => {
  it("updates hero cta.label", () => {
    const brief = baseBrief();
    const next = applyInlineEdit(brief, {
      origin: INSTINCT_EDIT_ORIGIN,
      type: "cta.edit",
      pageIndex: 0,
      sectionIndex: 0,
      field: "label",
      value: "Book a demo",
    });
    expect(next.pages[0].sections[0].cta?.label).toBe("Book a demo");
    // href untouched.
    expect(next.pages[0].sections[0].cta?.href).toBe("/go");
  });

  it("updates hero cta.href", () => {
    const brief = baseBrief();
    const next = applyInlineEdit(brief, {
      origin: INSTINCT_EDIT_ORIGIN,
      type: "cta.edit",
      pageIndex: 0,
      sectionIndex: 0,
      field: "href",
      value: "/demo",
    });
    expect(next.pages[0].sections[0].cta?.href).toBe("/demo");
  });

  it("creates cta if missing and writes label", () => {
    const brief = baseBrief();
    // Text section has no cta.
    const next = applyInlineEdit(brief, {
      origin: INSTINCT_EDIT_ORIGIN,
      type: "cta.edit",
      pageIndex: 0,
      sectionIndex: 1,
      field: "label",
      value: "Learn more",
    });
    expect(next.pages[0].sections[1].cta?.label).toBe("Learn more");
    expect(next.pages[0].sections[1].cta?.href).toBe("");
  });
});

describe("applyInlineEdit — out-of-range / invalid", () => {
  it("returns original brief on out-of-range pageIndex", () => {
    const brief = baseBrief();
    const next = applyInlineEdit(brief, {
      origin: INSTINCT_EDIT_ORIGIN,
      type: "text.edit",
      pageIndex: 42,
      sectionIndex: 0,
      field: "heading",
      value: "x",
    });
    expect(next).toBe(brief);
  });

  it("returns original brief on out-of-range sectionIndex", () => {
    const brief = baseBrief();
    const next = applyInlineEdit(brief, {
      origin: INSTINCT_EDIT_ORIGIN,
      type: "text.edit",
      pageIndex: 0,
      sectionIndex: 99,
      field: "heading",
      value: "x",
    });
    expect(next).toBe(brief);
  });

  it("returns original brief on negative indexes", () => {
    const brief = baseBrief();
    const next = applyInlineEdit(brief, {
      origin: INSTINCT_EDIT_ORIGIN,
      type: "text.edit",
      pageIndex: -1,
      sectionIndex: 0,
      field: "heading",
      value: "x",
    });
    expect(next).toBe(brief);
  });

  it("returns original brief on out-of-range testimonial itemIndex", () => {
    const brief = baseBrief();
    const msg = buildTestimonialEditMessage({
      pageIndex: 0,
      sectionIndex: 3,
      itemIndex: 99,
      field: "quote",
      value: "x",
    });
    const next = applyInlineEdit(brief, msg);
    expect(next).toBe(brief);
  });

  it("ignores tagline edits outside hero[0]", () => {
    const brief = baseBrief();
    const next = applyInlineEdit(brief, {
      origin: INSTINCT_EDIT_ORIGIN,
      type: "text.edit",
      pageIndex: 0,
      sectionIndex: 1,
      field: "tagline",
      value: "sneaky tagline",
    });
    expect(next).toBe(brief);
    expect(brief.product.tagline).toBe("We ship stuff");
  });

  it("returns original for non-edit types (ready, hover, brief.push)", () => {
    const brief = baseBrief();
    const noop: InlineEditMessage = {
      origin: INSTINCT_EDIT_ORIGIN,
      type: "ready",
    };
    expect(applyInlineEdit(brief, noop)).toBe(brief);
  });
});

describe("encodeBriefPush", () => {
  it("serializes a small brief to JSON envelope", () => {
    const encoded = encodeBriefPush({ hello: "world" });
    expect(encoded).toBeTruthy();
    const parsed = JSON.parse(encoded!);
    expect(parsed.origin).toBe(INSTINCT_EDIT_ORIGIN);
    expect(parsed.type).toBe("brief.push");
    expect(parsed.brief).toEqual({ hello: "world" });
  });

  it("returns null when payload exceeds MAX_POSTMESSAGE_BYTES", () => {
    // Build a brief whose serialized size exceeds the cap.
    const big = "x".repeat(MAX_POSTMESSAGE_BYTES + 10);
    expect(encodeBriefPush({ big })).toBeNull();
  });

  it("returns null on circular references (safe)", () => {
    const circ: { self?: unknown } = {};
    circ.self = circ;
    expect(encodeBriefPush(circ)).toBeNull();
  });
});
