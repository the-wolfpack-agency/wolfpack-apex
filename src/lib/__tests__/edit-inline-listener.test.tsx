/**
 * @jest-environment jsdom
 */

/**
 * Edit-page inline-edit listener contract.
 *
 * The full edit page suspends on `use(params)` in jsdom (the same reason
 * the existing helpers were extracted). We exercise the extracted pure
 * handler `handleInlineEditMessage` plus `readFieldValue` so we can lock
 * in:
 *   - origin mismatch → drop (security gate)
 *   - source mismatch → drop (security gate)
 *   - valid text.edit → draft updates + analytics event emitted
 *   - valid cta.edit → cta update + analytics event
 *   - hover → hover state returned, no draft mutation
 *   - char_delta reflects length difference
 *   - no-op edit (same value) → returns null
 */

import "@testing-library/jest-dom";
import {
  handleInlineEditMessage,
  readFieldValue,
} from "@/app/(dashboard)/sites/[id]/edit/page";
import { INSTINCT_EDIT_ORIGIN } from "@/lib/preview-postmessage";
import type { SiteBrief } from "@/lib/sites-schema";

function brief(): SiteBrief {
  return {
    client: "acme",
    product: { name: "Acme", tagline: "Ship it" },
    pages: [
      {
        route: "/",
        sections: [
          {
            type: "hero",
            heading: "Old hero",
            body: "Old body",
            cta: { label: "Go", href: "/go" },
          },
          { type: "text", heading: "Text", body: "Words" },
        ],
      },
    ],
  };
}

const SITE_ID = "site_test";
const FAKE_SOURCE = { tag: "iframe-content-window" };
const ORIGIN = "https://example.test";

function event(data: unknown, overrides?: { origin?: string; source?: unknown }) {
  return {
    origin: overrides?.origin ?? ORIGIN,
    source: overrides?.source ?? FAKE_SOURCE,
    data,
  } as Pick<MessageEvent, "origin" | "source" | "data">;
}

describe("handleInlineEditMessage — security gates", () => {
  it("drops messages from untrusted origin", () => {
    const res = handleInlineEditMessage({
      event: event(
        {
          origin: INSTINCT_EDIT_ORIGIN,
          type: "text.edit",
          pageIndex: 0,
          sectionIndex: 0,
          field: "heading",
          value: "pwn",
        },
        { origin: "https://evil.test" },
      ),
      expectedOrigin: ORIGIN,
      expectedSource: FAKE_SOURCE,
      currentDraft: brief(),
      siteId: SITE_ID,
    });
    expect(res).toBeNull();
  });

  it("drops messages from untrusted source (different window)", () => {
    const res = handleInlineEditMessage({
      event: event(
        {
          origin: INSTINCT_EDIT_ORIGIN,
          type: "text.edit",
          pageIndex: 0,
          sectionIndex: 0,
          field: "heading",
          value: "pwn",
        },
        { source: { tag: "other" } },
      ),
      expectedOrigin: ORIGIN,
      expectedSource: FAKE_SOURCE,
      currentDraft: brief(),
      siteId: SITE_ID,
    });
    expect(res).toBeNull();
  });

  it("drops messages with wrong protocol origin brand", () => {
    const res = handleInlineEditMessage({
      event: event({
        origin: "some.other.channel",
        type: "text.edit",
        pageIndex: 0,
        sectionIndex: 0,
        field: "heading",
        value: "x",
      }),
      expectedOrigin: ORIGIN,
      expectedSource: FAKE_SOURCE,
      currentDraft: brief(),
      siteId: SITE_ID,
    });
    expect(res).toBeNull();
  });
});

describe("handleInlineEditMessage — valid edits", () => {
  it("applies a text.edit, returns next draft + analytics event", () => {
    const res = handleInlineEditMessage({
      event: event({
        origin: INSTINCT_EDIT_ORIGIN,
        type: "text.edit",
        pageIndex: 0,
        sectionIndex: 0,
        field: "heading",
        value: "New hero headline",
      }),
      expectedOrigin: ORIGIN,
      expectedSource: FAKE_SOURCE,
      currentDraft: brief(),
      siteId: SITE_ID,
    });
    expect(res).not.toBeNull();
    expect(res!.nextDraft!.pages[0].sections[0].heading).toBe("New hero headline");
    expect(res!.analytics?.event).toBe("site.inline_text_edited");
    expect(res!.analytics?.metadata.section_type).toBe("hero");
    expect(res!.analytics?.metadata.field).toBe("heading");
    // char_delta = new("New hero headline").length - old("Old hero").length
    expect(res!.analytics?.metadata.char_delta).toBe(
      "New hero headline".length - "Old hero".length,
    );
  });

  it("applies a cta.edit, returns next draft + analytics", () => {
    const res = handleInlineEditMessage({
      event: event({
        origin: INSTINCT_EDIT_ORIGIN,
        type: "cta.edit",
        pageIndex: 0,
        sectionIndex: 0,
        field: "label",
        value: "Book a demo",
      }),
      expectedOrigin: ORIGIN,
      expectedSource: FAKE_SOURCE,
      currentDraft: brief(),
      siteId: SITE_ID,
    });
    expect(res).not.toBeNull();
    expect(res!.nextDraft!.pages[0].sections[0].cta?.label).toBe("Book a demo");
    expect(res!.analytics?.event).toBe("site.inline_cta_edited");
    expect(res!.analytics?.metadata.field).toBe("label");
  });

  it("hover returns hover state without mutating draft", () => {
    const res = handleInlineEditMessage({
      event: event({
        origin: INSTINCT_EDIT_ORIGIN,
        type: "hover",
        pageIndex: 0,
        sectionIndex: 0,
        sectionType: "hero",
      }),
      expectedOrigin: ORIGIN,
      expectedSource: FAKE_SOURCE,
      currentDraft: brief(),
      siteId: SITE_ID,
    });
    expect(res).not.toBeNull();
    expect(res!.hover).toEqual({ sectionType: "hero", route: "/" });
    expect(res!.nextDraft).toBeNull();
    expect(res!.analytics).toBeNull();
  });

  it("returns null for no-op text.edit with unchanged value", () => {
    const res = handleInlineEditMessage({
      event: event({
        origin: INSTINCT_EDIT_ORIGIN,
        type: "text.edit",
        pageIndex: 0,
        sectionIndex: 0,
        field: "heading",
        value: "Old hero",
      }),
      expectedOrigin: ORIGIN,
      expectedSource: FAKE_SOURCE,
      currentDraft: brief(),
      siteId: SITE_ID,
    });
    expect(res).toBeNull();
  });

  it("returns null for out-of-range indices (applyInlineEdit bails)", () => {
    const res = handleInlineEditMessage({
      event: event({
        origin: INSTINCT_EDIT_ORIGIN,
        type: "text.edit",
        pageIndex: 42,
        sectionIndex: 0,
        field: "heading",
        value: "x",
      }),
      expectedOrigin: ORIGIN,
      expectedSource: FAKE_SOURCE,
      currentDraft: brief(),
      siteId: SITE_ID,
    });
    expect(res).toBeNull();
  });

  it("returns null when no draft is loaded yet", () => {
    const res = handleInlineEditMessage({
      event: event({
        origin: INSTINCT_EDIT_ORIGIN,
        type: "text.edit",
        pageIndex: 0,
        sectionIndex: 0,
        field: "heading",
        value: "x",
      }),
      expectedOrigin: ORIGIN,
      expectedSource: FAKE_SOURCE,
      currentDraft: null,
      siteId: SITE_ID,
    });
    expect(res).toBeNull();
  });
});

describe("readFieldValue", () => {
  it("reads hero heading / body / tagline", () => {
    const b = brief();
    expect(
      readFieldValue(b, {
        origin: INSTINCT_EDIT_ORIGIN,
        type: "text.edit",
        pageIndex: 0,
        sectionIndex: 0,
        field: "heading",
        value: "",
      }),
    ).toBe("Old hero");
    expect(
      readFieldValue(b, {
        origin: INSTINCT_EDIT_ORIGIN,
        type: "text.edit",
        pageIndex: 0,
        sectionIndex: 0,
        field: "body",
        value: "",
      }),
    ).toBe("Old body");
    expect(
      readFieldValue(b, {
        origin: INSTINCT_EDIT_ORIGIN,
        type: "text.edit",
        pageIndex: 0,
        sectionIndex: 0,
        field: "tagline",
        value: "",
      }),
    ).toBe("Ship it");
  });

  it("returns empty string for missing fields", () => {
    const b = brief();
    expect(
      readFieldValue(b, {
        origin: INSTINCT_EDIT_ORIGIN,
        type: "text.edit",
        pageIndex: 0,
        sectionIndex: 1,
        field: "attribution",
        value: "",
      }),
    ).toBe("");
  });
});
