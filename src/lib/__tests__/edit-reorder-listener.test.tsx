/**
 * @jest-environment jsdom
 */

/**
 * Edit-page listener contract for section.reorder (Path C Phase 2 · Q1).
 *
 * Same approach as `edit-inline-listener.test.tsx` — the full edit page
 * suspends on `use(params)` in jsdom, so we exercise the exported pure
 * handler `handleInlineEditMessage`. Locks in:
 *   - section.reorder from trusted origin + source → nextDraft has
 *     sections reordered + analytics event carries move_distance.
 *   - Untrusted origin / source → dropped (security parity with the
 *     existing inline-edit gates).
 *   - No-op (same index, invalid indices) → null.
 *   - The analytics event type is wired up as `site.section_reordered`.
 */

import "@testing-library/jest-dom";
import { handleInlineEditMessage } from "@/app/(dashboard)/sites/[id]/edit/page";
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
          { type: "hero", heading: "Hero" },
          { type: "pricing", items: [{ name: "Pro", price: "$99" }] },
          { type: "testimonial", items: [{ quote: "Great", authorName: "A" }] },
          { type: "faq", items: [{ question: "Q?", answer: "A." }] },
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

function reorderEvent(
  from: number,
  to: number,
  pageIndex = 0,
  overrides?: { origin?: string; source?: unknown },
) {
  return event(
    {
      origin: INSTINCT_EDIT_ORIGIN,
      type: "section.reorder",
      pageIndex,
      fromIndex: from,
      toIndex: to,
    },
    overrides,
  );
}

describe("handleInlineEditMessage — section.reorder happy path", () => {
  it("valid reorder produces nextDraft + analytics with move_distance", () => {
    const res = handleInlineEditMessage({
      event: reorderEvent(2, 0),
      expectedOrigin: ORIGIN,
      expectedSource: FAKE_SOURCE,
      currentDraft: brief(),
      siteId: SITE_ID,
    });
    expect(res).not.toBeNull();
    // testimonial (index 2) moved to index 0; others shifted down.
    expect(res!.nextDraft!.pages[0].sections.map((s) => s.type)).toEqual([
      "testimonial",
      "hero",
      "pricing",
      "faq",
    ]);
    expect(res!.analytics?.event).toBe("site.section_reordered");
    expect(res!.analytics?.metadata.site_id).toBe(SITE_ID);
    expect(res!.analytics?.metadata.page_index).toBe(0);
    expect(res!.analytics?.metadata.section_type_moved).toBe("testimonial");
    expect(res!.analytics?.metadata.from_index).toBe(2);
    expect(res!.analytics?.metadata.to_index).toBe(0);
    // move_distance = to - from = 0 - 2 = -2 (promoted upward)
    expect(res!.analytics?.metadata.move_distance).toBe(-2);
  });

  it("downward move produces positive move_distance", () => {
    const res = handleInlineEditMessage({
      event: reorderEvent(0, 3),
      expectedOrigin: ORIGIN,
      expectedSource: FAKE_SOURCE,
      currentDraft: brief(),
      siteId: SITE_ID,
    });
    expect(res).not.toBeNull();
    expect(res!.analytics?.metadata.move_distance).toBe(3);
    expect(res!.analytics?.metadata.section_type_moved).toBe("hero");
  });
});

describe("handleInlineEditMessage — section.reorder security gates", () => {
  it("untrusted origin → draft unchanged (null)", () => {
    const res = handleInlineEditMessage({
      event: reorderEvent(0, 2, 0, { origin: "https://evil.test" }),
      expectedOrigin: ORIGIN,
      expectedSource: FAKE_SOURCE,
      currentDraft: brief(),
      siteId: SITE_ID,
    });
    expect(res).toBeNull();
  });

  it("untrusted source → draft unchanged (null)", () => {
    const res = handleInlineEditMessage({
      event: reorderEvent(0, 2, 0, { source: { tag: "impostor" } }),
      expectedOrigin: ORIGIN,
      expectedSource: FAKE_SOURCE,
      currentDraft: brief(),
      siteId: SITE_ID,
    });
    expect(res).toBeNull();
  });
});

describe("handleInlineEditMessage — section.reorder no-ops", () => {
  it("same-index reorder returns null", () => {
    const res = handleInlineEditMessage({
      event: reorderEvent(1, 1),
      expectedOrigin: ORIGIN,
      expectedSource: FAKE_SOURCE,
      currentDraft: brief(),
      siteId: SITE_ID,
    });
    expect(res).toBeNull();
  });

  it("invalid indices → null (no analytics, no draft mutation)", () => {
    const res = handleInlineEditMessage({
      event: reorderEvent(42, 0),
      expectedOrigin: ORIGIN,
      expectedSource: FAKE_SOURCE,
      currentDraft: brief(),
      siteId: SITE_ID,
    });
    expect(res).toBeNull();
  });

  it("reorder with no draft loaded → null", () => {
    const res = handleInlineEditMessage({
      event: reorderEvent(0, 1),
      expectedOrigin: ORIGIN,
      expectedSource: FAKE_SOURCE,
      currentDraft: null,
      siteId: SITE_ID,
    });
    expect(res).toBeNull();
  });
});
