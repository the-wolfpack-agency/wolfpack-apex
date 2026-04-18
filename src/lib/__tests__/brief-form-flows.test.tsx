/**
 * @jest-environment jsdom
 */

/**
 * BriefForm — deep-mount user-flow regression suite.
 *
 * WHY THIS FILE EXISTS
 *
 * For 20+ commits we've been patching editor bugs from helper-only tests
 * (`brief-form.test.ts` reads the source file; `brief-form-a11y.test.tsx`
 * checks id/name attributes). Neither one clicks a button or types in a
 * field. Every session the user finds a new interactive regression that
 * slipped past those tests because nothing actually MOUNTED the form
 * and exercised it.
 *
 * This file mounts `<BriefForm>` with a real brief and walks every
 * section-type editor + every add/remove/reorder control + the JSON
 * view toggle. Each test asserts either a DOM change or an onChange
 * call — no "didn't throw" tests, no helper-only tests.
 *
 * Owner: Brief form interactions. Sibling files own asset upload
 * (streams in parallel) + Playwright E2E (separate stream). No overlap.
 *
 * Engineering-directive checklist for this file:
 *   - Tests at the UI layer (jsdom mount + user events).          ✓
 *   - Every new surface exercised — all 8 section types.          ✓
 *   - onChange-driven assertions prove data flows out (to the
 *     parent, which persists + emits `site.brief_form_edited`).   ✓
 *   - No regressions: does not touch BriefForm.tsx or any other
 *     test file.                                                  ✓
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";

import { BriefForm, type Brief, type Section } from "@/components/sites/BriefForm";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal but complete brief with one instance of each of the 8 section
 * types. Used by tests that want to start from "all editors visible" and
 * exercise one at a time. A fresh copy per test to avoid mutation leak.
 */
function allSectionsBrief(): Brief {
  return {
    client: "test",
    product: {
      name: "Test Co",
      tagline: "Do the thing",
      domain: "example.com",
      supportEmail: "hello@example.com",
    },
    pages: [
      {
        route: "/",
        sections: [
          {
            type: "hero",
            heading: "Hello",
            body: "Sub",
            backgroundImage: "/bg.jpg",
            cta: { label: "Go", href: "/go" },
          },
          { type: "text", heading: "Intro", body: "Words." },
          { type: "callout", body: "Heads up." },
          { type: "banner", heading: "Season", body: "Winter sale." },
          {
            type: "stats",
            heading: "By the numbers",
            items: [{ label: "Races", value: 12, prefix: "", suffix: "" }],
          },
          {
            type: "cards",
            heading: "Team",
            items: [{ title: "Driver", body: "Bio", badge: "", accent: false }],
          },
          {
            type: "gallery",
            heading: "Photos",
            images: [{ src: "/a.jpg", alt: "a" }],
          },
          { type: "quote", body: "Quoted.", attribution: "Someone" },
        ],
      },
    ],
  };
}

function emptyBrief(): Brief {
  return {
    client: "test",
    product: { name: "Test Co" },
    pages: [{ route: "/", sections: [] }],
  };
}

/**
 * Controlled wrapper: onChange propagates into state so interactive
 * flows (add → type → remove) reflect onto the next render. Also
 * records every onChange call so tests can assert on the sequence.
 */
function Harness({
  initial,
  onChangeSpy,
}: {
  initial: Brief;
  onChangeSpy: jest.Mock<void, [Brief]>;
}) {
  const [value, setValue] = useState<Brief>(initial);
  return (
    <BriefForm
      value={value}
      onChange={(next) => {
        onChangeSpy(next);
        setValue(next);
      }}
    />
  );
}

function mountWith(initial: Brief) {
  const onChange = jest.fn<void, [Brief]>();
  const utils = render(<Harness initial={initial} onChangeSpy={onChange} />);
  return { ...utils, onChange };
}

// Grab the current `sections` array off the most recent onChange call.
// Returns the empty array if onChange was never called (test sets this
// up before asserting so an unexpected undefined is a bug).
function lastSections(onChange: jest.Mock<void, [Brief]>): Section[] {
  expect(onChange).toHaveBeenCalled();
  const last = onChange.mock.calls[onChange.mock.calls.length - 1][0];
  return last.pages[0].sections;
}

function lastBrief(onChange: jest.Mock<void, [Brief]>): Brief {
  expect(onChange).toHaveBeenCalled();
  return onChange.mock.calls[onChange.mock.calls.length - 1][0];
}

// Find the section card (outer div with data-section=<type>). Throws if
// not found so failures are loud instead of silently testing nothing.
function sectionCard(container: HTMLElement, type: string, index = 0): HTMLElement {
  const nodes = container.querySelectorAll<HTMLElement>(`[data-section="${type}"]`);
  const el = nodes.item(index);
  if (!el) throw new Error(`section card ${type}[${index}] not in DOM`);
  return el;
}

// Resolve a <label> to its target input using htmlFor → id. We can't use
// getByLabelText for inline stats/cards/gallery inputs (those use
// aria-label), so provide a hero/text/banner/quote-friendly helper too.
function inputByLabel(card: HTMLElement, labelText: string): HTMLElement {
  const labels = card.querySelectorAll<HTMLLabelElement>("label[for]");
  for (const lbl of Array.from(labels)) {
    if (lbl.textContent?.trim() === labelText) {
      const targetId = lbl.getAttribute("for")!;
      const el = card.querySelector<HTMLElement>(`#${CSS.escape(targetId)}`);
      if (el) return el;
    }
  }
  throw new Error(`no input for label "${labelText}" in card`);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("brief-form — deep-mount flows", () => {
  it("brief-form — mount with all 8 section types renders one card per type", () => {
    const { container } = mountWith(allSectionsBrief());
    for (const type of ["hero", "text", "callout", "banner", "stats", "cards", "gallery", "quote"]) {
      expect(container.querySelectorAll(`[data-section="${type}"]`).length).toBe(1);
    }
    // Sanity: 8 total section cards.
    expect(container.querySelectorAll("[data-section]").length).toBe(8);
  });

  it("brief-form — product fields (display name, tagline, domain, support email) edit through onChange; no client-side email validation", () => {
    const { container, onChange } = mountWith(allSectionsBrief());
    // Product section is the first <h3>Product</h3> + the 4 Field grid
    // directly underneath. All four labels live outside any data-section
    // card, so the first matching label is the product one.
    function productField(label: string): HTMLInputElement {
      const lbl = Array.from(container.querySelectorAll<HTMLLabelElement>("label[for]"))
        .find((l) => l.textContent?.trim() === label);
      if (!lbl) throw new Error(`product field ${label} not found`);
      const id = lbl.getAttribute("for")!;
      return container.querySelector<HTMLInputElement>(`#${CSS.escape(id)}`)!;
    }

    fireEvent.change(productField("Display name"), { target: { value: "New Co" } });
    fireEvent.change(productField("Tagline"), { target: { value: "New tagline" } });
    fireEvent.change(productField("Domain"), { target: { value: "new.example.com" } });
    // Garbage email on purpose — the form must accept it. Server-side
    // validateBrief() enforces the regex; the form doesn't block typing.
    fireEvent.change(productField("Support email"), { target: { value: "not-an-email" } });

    expect(onChange).toHaveBeenCalledTimes(4);
    const final = lastBrief(onChange);
    expect(final.product.name).toBe("New Co");
    expect(final.product.tagline).toBe("New tagline");
    expect(final.product.domain).toBe("new.example.com");
    expect(final.product.supportEmail).toBe("not-an-email");
    // Form did not surface any validation error message for the bogus
    // email — per spec, server validates.
    expect(container.textContent).not.toMatch(/invalid email/i);
  });

  it("brief-form — hero section: heading, body, background image, CTA label all round-trip via onChange", () => {
    const { container, onChange } = mountWith(allSectionsBrief());
    const hero = sectionCard(container, "hero");

    fireEvent.change(inputByLabel(hero, "Heading"), { target: { value: "New heading" } });
    fireEvent.change(inputByLabel(hero, "Body"), { target: { value: "New body" } });
    fireEvent.change(inputByLabel(hero, "Background image URL"), { target: { value: "/new.jpg" } });
    fireEvent.change(inputByLabel(hero, "CTA label"), { target: { value: "Click me" } });

    expect(onChange).toHaveBeenCalledTimes(4);
    const heroOut = lastSections(onChange).find((s) => s.type === "hero")!;
    expect(heroOut.heading).toBe("New heading");
    expect(heroOut.body).toBe("New body");
    expect(heroOut.backgroundImage).toBe("/new.jpg");
    expect(heroOut.cta?.label).toBe("Click me");
    // Existing href must be preserved when only the label was typed —
    // fixture starts with href="/go", so /go round-trips, not "/contact".
    expect(heroOut.cta?.href).toBe("/go");
  });

  it("brief-form — hero CTA: label edit on a section with NO existing cta.href defaults href to /contact", () => {
    const brief = allSectionsBrief();
    // Strip the cta entirely from the hero section to exercise the
    // defaulting branch in the component (href ?? "/contact").
    const heroIdx = brief.pages[0].sections.findIndex((s) => s.type === "hero");
    delete (brief.pages[0].sections[heroIdx] as Section).cta;

    const { container, onChange } = mountWith(brief);
    const hero = sectionCard(container, "hero");
    fireEvent.change(inputByLabel(hero, "CTA label"), { target: { value: "Click me" } });

    const heroOut = lastSections(onChange).find((s) => s.type === "hero")!;
    expect(heroOut.cta?.label).toBe("Click me");
    expect(heroOut.cta?.href).toBe("/contact");
  });

  it("brief-form — text/callout/banner editors all patch heading + body onto the right section", () => {
    const { container, onChange } = mountWith(allSectionsBrief());

    const text = sectionCard(container, "text");
    fireEvent.change(inputByLabel(text, "Heading"), { target: { value: "Text heading" } });
    fireEvent.change(inputByLabel(text, "Body"), { target: { value: "Text body" } });

    // callout has no Heading field by design — only Body. Verify that.
    const callout = sectionCard(container, "callout");
    expect(() => inputByLabel(callout, "Heading")).toThrow();
    fireEvent.change(inputByLabel(callout, "Body"), { target: { value: "Callout body" } });

    const banner = sectionCard(container, "banner");
    fireEvent.change(inputByLabel(banner, "Heading"), { target: { value: "Banner heading" } });
    fireEvent.change(inputByLabel(banner, "Body"), { target: { value: "Banner body" } });

    const sections = lastSections(onChange);
    expect(sections.find((s) => s.type === "text")).toMatchObject({
      heading: "Text heading",
      body: "Text body",
    });
    expect(sections.find((s) => s.type === "callout")).toMatchObject({
      body: "Callout body",
    });
    expect(sections.find((s) => s.type === "banner")).toMatchObject({
      heading: "Banner heading",
      body: "Banner body",
    });
  });

  it("brief-form — stats: add row, type label + numeric value, remove row; value is a number in onChange payload", () => {
    const { container, onChange } = mountWith(allSectionsBrief());
    const stats = sectionCard(container, "stats");

    // 1 existing row → click + stat → now 2 rows.
    const addBtn = within(stats).getByRole("button", { name: "+ stat" });
    fireEvent.click(addBtn);
    expect(lastSections(onChange).find((s) => s.type === "stats")!.items!.length).toBe(2);

    // After onChange triggers re-render, pick up the fresh node.
    const statsLive = sectionCard(container, "stats");
    const row2Label = within(statsLive).getByLabelText("Stat 2 label") as HTMLInputElement;
    const row2Value = within(statsLive).getByLabelText("Stat 2 value") as HTMLInputElement;

    fireEvent.change(row2Label, { target: { value: "Wins" } });
    fireEvent.change(row2Value, { target: { value: "42" } });

    const statsOut = lastSections(onChange).find((s) => s.type === "stats")!;
    const items = statsOut.items as Array<{ label?: string; value?: unknown }>;
    expect(items[1].label).toBe("Wins");
    // Critical: value must be a number, NOT a string. Regression guard
    // against the `value = e.target.value` bug where stats render as
    // "42" and blow up validateBrief() server-side.
    expect(typeof items[1].value).toBe("number");
    expect(items[1].value).toBe(42);

    // Remove the 2nd row via its ✕ button. The section-level ✕ at the
    // card header uses aria-label="Remove" (not the glyph), so name:"✕"
    // only matches the two inline row buttons.
    const removeButtons = within(statsLive).getAllByRole("button", { name: "✕" });
    expect(removeButtons.length).toBe(2);
    fireEvent.click(removeButtons[removeButtons.length - 1]);

    const afterRemove = lastSections(onChange).find((s) => s.type === "stats")!;
    expect(afterRemove.items!.length).toBe(1);
  });

  it("brief-form — cards: add row, toggle accent checkbox as boolean, remove row", () => {
    const { container, onChange } = mountWith(allSectionsBrief());
    const cards = sectionCard(container, "cards");

    fireEvent.click(within(cards).getByRole("button", { name: "+ card" }));
    expect(lastSections(onChange).find((s) => s.type === "cards")!.items!.length).toBe(2);

    // Re-query after re-render.
    const cardsLive = sectionCard(container, "cards");
    const accentBox = within(cardsLive).getAllByRole("checkbox")[0] as HTMLInputElement;
    fireEvent.click(accentBox);
    let cardsOut = lastSections(onChange).find((s) => s.type === "cards")!;
    const items = cardsOut.items as Array<{ accent?: unknown }>;
    // Row 0 started accent:false → toggle true. Must be a real boolean.
    expect(items[0].accent).toBe(true);
    expect(typeof items[0].accent).toBe("boolean");

    // Remove row 2 (the one we just added) — last ✕ in DOM order.
    const removeButtons = within(cardsLive).getAllByRole("button", { name: "✕" });
    fireEvent.click(removeButtons[removeButtons.length - 1]);
    cardsOut = lastSections(onChange).find((s) => s.type === "cards")!;
    expect(cardsOut.items!.length).toBe(1);
  });

  it("brief-form — gallery: add image, edit src + alt, remove image — all shapes are {src, alt} objects never strings", () => {
    const { container, onChange } = mountWith(allSectionsBrief());
    const gallery = sectionCard(container, "gallery");

    fireEvent.click(within(gallery).getByRole("button", { name: "+ image" }));
    expect(lastSections(onChange).find((s) => s.type === "gallery")!.images!.length).toBe(2);

    const galleryLive = sectionCard(container, "gallery");
    const img2Src = within(galleryLive).getByLabelText("Image 2 URL") as HTMLInputElement;
    const img2Alt = within(galleryLive).getByLabelText("Image 2 alt text") as HTMLInputElement;
    fireEvent.change(img2Src, { target: { value: "/new.jpg" } });
    fireEvent.change(img2Alt, { target: { value: "new alt" } });

    let galleryOut = lastSections(onChange).find((s) => s.type === "gallery")!;
    expect(galleryOut.images).toEqual([
      { src: "/a.jpg", alt: "a" },
      { src: "/new.jpg", alt: "new alt" },
    ]);
    // Invariant: images must always be object form post-edit. Serialized
    // string shorthand is never re-introduced.
    for (const img of galleryOut.images!) {
      expect(typeof img).toBe("object");
      expect(img).toHaveProperty("src");
    }

    // Remove image 2.
    const removeButtons = within(galleryLive).getAllByRole("button", { name: "✕" });
    fireEvent.click(removeButtons[removeButtons.length - 1]);
    galleryOut = lastSections(onChange).find((s) => s.type === "gallery")!;
    expect(galleryOut.images!.length).toBe(1);
  });

  it("brief-form — quote: body + attribution fields round-trip", () => {
    const { container, onChange } = mountWith(allSectionsBrief());
    const quote = sectionCard(container, "quote");
    fireEvent.change(inputByLabel(quote, "Quote"), { target: { value: "Fresh quote" } });
    fireEvent.change(inputByLabel(quote, "Attribution"), { target: { value: "New Voice" } });

    const quoteOut = lastSections(onChange).find((s) => s.type === "quote")!;
    expect(quoteOut.body).toBe("Fresh quote");
    expect(quoteOut.attribution).toBe("New Voice");
  });

  it("brief-form — add-section buttons: + <type> appends a new section with the right default items shape", () => {
    const { container, onChange, getByRole } = mountWith(emptyBrief());
    // For each section type, clicking "+ <type>" should append a section
    // with the correct default items/images shape.
    const expectations: Array<{ type: string; check: (s: Section) => void }> = [
      { type: "hero", check: (s) => { expect(s.type).toBe("hero"); } },
      { type: "text", check: (s) => { expect(s.type).toBe("text"); } },
      { type: "callout", check: (s) => { expect(s.type).toBe("callout"); } },
      { type: "banner", check: (s) => { expect(s.type).toBe("banner"); } },
      {
        type: "stats",
        check: (s) => {
          expect(s.type).toBe("stats");
          expect(s.items).toEqual([{ label: "", value: 0 }]);
        },
      },
      {
        type: "cards",
        check: (s) => {
          expect(s.type).toBe("cards");
          expect(s.items).toEqual([{ title: "", body: "" }]);
        },
      },
      {
        type: "gallery",
        check: (s) => {
          expect(s.type).toBe("gallery");
          expect(s.images).toEqual([]);
        },
      },
      { type: "quote", check: (s) => { expect(s.type).toBe("quote"); } },
    ];

    for (let i = 0; i < expectations.length; i++) {
      const { type, check } = expectations[i];
      // Click the "+ <type>" button. Add-section buttons are rendered at
      // the bottom of the form, so scope lookup to the form root.
      const btn = getByRole("button", { name: `+ ${type}` });
      fireEvent.click(btn);
      const sections = lastSections(onChange);
      expect(sections.length).toBe(i + 1);
      check(sections[i]);
    }
    // Sanity: 8 section cards in the DOM after the loop.
    expect(container.querySelectorAll("[data-section]").length).toBe(8);
  });

  it("brief-form — ✕ on a section card removes it from the page", () => {
    const { container, onChange } = mountWith(allSectionsBrief());
    // Remove the "callout" section. Its card has aria-label="Remove"
    // on the ✕ button (top-right of the card).
    const callout = sectionCard(container, "callout");
    const removeBtn = within(callout).getByRole("button", { name: "Remove" });
    fireEvent.click(removeBtn);

    const sections = lastSections(onChange);
    expect(sections.find((s) => s.type === "callout")).toBeUndefined();
    expect(sections.length).toBe(7);
  });

  it("brief-form — ↑ / ↓ reorder buttons swap with neighbor; last section can't move further down", () => {
    const { container, onChange } = mountWith(allSectionsBrief());

    // Starting order: hero, text, callout, banner, stats, cards, gallery, quote
    // Click ↓ on the first card (hero) → hero + text swap.
    const hero = sectionCard(container, "hero");
    fireEvent.click(within(hero).getByRole("button", { name: "Move down" }));
    let sections = lastSections(onChange);
    expect(sections[0].type).toBe("text");
    expect(sections[1].type).toBe("hero");

    // Click ↓ on the last card (quote) — no-op, no new onChange.
    const callsBefore = onChange.mock.calls.length;
    const quote = sectionCard(container, "quote");
    fireEvent.click(within(quote).getByRole("button", { name: "Move down" }));
    expect(onChange.mock.calls.length).toBe(callsBefore);

    // Click ↑ on the 2nd card (now hero after the first swap) — swap back.
    const heroAgain = sectionCard(container, "hero");
    fireEvent.click(within(heroAgain).getByRole("button", { name: "Move up" }));
    sections = lastSections(onChange);
    expect(sections[0].type).toBe("hero");
    expect(sections[1].type).toBe("text");
  });

  it("brief-form — JSON view: Show JSON swaps to textarea with pretty-printed brief, edits parse through onChange, malformed JSON is silently ignored", () => {
    const { container, onChange, getByRole } = mountWith(allSectionsBrief());

    fireEvent.click(getByRole("button", { name: "Show JSON" }));
    const textarea = container.querySelector<HTMLTextAreaElement>("#brief-json-editor")!;
    expect(textarea).toBeTruthy();
    // Pretty-printed (JSON.stringify(value, null, 2)) → 2-space indent
    // markers should be present.
    expect(textarea.value).toContain('"client": "test"');
    expect(textarea.value).toMatch(/\n {2}"client":/);

    // Malformed JSON → no onChange call.
    const callsBefore = onChange.mock.calls.length;
    fireEvent.change(textarea, { target: { value: "{ not valid json" } });
    expect(onChange.mock.calls.length).toBe(callsBefore);

    // Valid JSON with a rename → onChange fires with the parsed object.
    const edited = {
      ...allSectionsBrief(),
      product: { ...allSectionsBrief().product, name: "Renamed Co" },
    };
    fireEvent.change(textarea, { target: { value: JSON.stringify(edited) } });
    expect(onChange).toHaveBeenCalled();
    const parsed = lastBrief(onChange);
    expect(parsed.product.name).toBe("Renamed Co");
  });

  it("brief-form — ← Form view button returns to the form editor from JSON view", () => {
    const { container, getByRole } = mountWith(allSectionsBrief());
    // Enter JSON view, then bail out.
    fireEvent.click(getByRole("button", { name: "Show JSON" }));
    expect(container.querySelector('[data-brief-form="json"]')).toBeTruthy();
    expect(container.querySelector('[data-brief-form="form"]')).toBeFalsy();

    // Button label is "← Form view" — fireEvent can't easily match the
    // left arrow via accessible name in some environments; match on text.
    const backBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Form view"),
    )!;
    expect(backBtn).toBeTruthy();
    act(() => {
      fireEvent.click(backBtn);
    });
    expect(container.querySelector('[data-brief-form="form"]')).toBeTruthy();
    expect(container.querySelector('[data-brief-form="json"]')).toBeFalsy();
    // All 8 section cards are back.
    expect(container.querySelectorAll("[data-section]").length).toBe(8);
  });
});
