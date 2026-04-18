/**
 * @jest-environment jsdom
 */

/**
 * BriefForm form-field accessibility — regression lock.
 *
 * This test actually MOUNTS <BriefForm /> with a brief containing every
 * section type, walks the rendered DOM, and asserts that every input,
 * textarea, and select has BOTH an id and a name attribute. The
 * failure mode it prevents is the 2026-04-18 production bug where
 * Chrome's Issues panel counted "A form field element should have an
 * id or name attribute" hundreds of times — each render of the form
 * re-fired the warning per unlabeled field.
 *
 * Previous regression attempts only tested helpers. That's exactly
 * what the engineering directive calls out: tests that prove code
 * compiles, not that the feature works. This one actually walks the
 * rendered tree so any new unlabeled field fails the commit that
 * introduces it.
 */

import "@testing-library/jest-dom";
import { render } from "@testing-library/react";

import { BriefForm, type Brief } from "@/components/sites/BriefForm";

// A brief that exercises every supported section type so the test
// mounts the full SectionEditor switch + its inline inputs, not just
// the Field wrapper path.
function briefWithAllSections(): Brief {
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
          { type: "hero", heading: "Hero", body: "Body", backgroundImage: "", cta: { label: "Go", href: "/go" } },
          { type: "text", heading: "Intro", body: "Words." },
          { type: "callout", body: "Watch out." },
          { type: "banner", heading: "Season", body: "One." },
          {
            type: "stats",
            heading: "By the numbers",
            items: [
              { label: "Races", value: 12, prefix: "", suffix: "" },
              { label: "Podiums", value: 4, prefix: "", suffix: "" },
            ],
          },
          {
            type: "cards",
            heading: "Team",
            items: [
              { title: "Driver", body: "Bio", badge: "", accent: false },
              { title: "Crew", body: "Bio", badge: "lead", accent: true },
            ],
          },
          {
            type: "gallery",
            heading: "Photos",
            images: [
              { src: "/a.jpg", alt: "a" },
              { src: "/b.jpg", alt: "b" },
            ],
          },
          { type: "quote", body: "Quoted.", attribution: "Someone" },
        ],
      },
    ],
  };
}

describe("BriefForm a11y — every rendered field has id + name", () => {
  it("every <input>, <textarea>, <select> has both id AND name attributes populated", () => {
    const { container } = render(
      <BriefForm value={briefWithAllSections()} onChange={() => {}} />,
    );
    const fields = container.querySelectorAll<HTMLElement>("input, textarea, select");
    // Sanity: we expect at least the 4 product fields + 1 hero heading +
    // 1 hero body + 1 hero bg + 1 hero CTA + … enough to catch a
    // regression where a whole section type dropped its fields.
    expect(fields.length).toBeGreaterThan(15);

    const offenders: string[] = [];
    fields.forEach((el, i) => {
      const id = el.getAttribute("id");
      const name = el.getAttribute("name");
      if (!id || !name) {
        offenders.push(
          `[${i}] <${el.tagName.toLowerCase()}> id=${JSON.stringify(id)} name=${JSON.stringify(name)} placeholder=${JSON.stringify(el.getAttribute("placeholder"))}`,
        );
      }
    });
    // If anything fails, the message lists each unlabeled field so we
    // don't have to bisect.
    expect(offenders).toEqual([]);
  });

  it("every <input>/<textarea> with an id is reachable from some <label htmlFor> OR has aria-label", () => {
    const { container } = render(
      <BriefForm value={briefWithAllSections()} onChange={() => {}} />,
    );
    const labels = Array.from(container.querySelectorAll<HTMLLabelElement>("label[for]"));
    const labelTargets = new Set(labels.map((l) => l.getAttribute("for")));

    const fields = container.querySelectorAll<HTMLElement>("input, textarea, select");
    const unlabeled: string[] = [];
    fields.forEach((el) => {
      const id = el.getAttribute("id");
      const ariaLabel = el.getAttribute("aria-label");
      // Count as labeled if: (a) a <label for=id> exists, or (b) element
      // has aria-label. Wrapping <label><input/></label> also counts —
      // the element's closest label.
      const wrappedLabel = el.closest("label");
      const linked = id ? labelTargets.has(id) : false;
      if (!linked && !ariaLabel && !wrappedLabel) {
        unlabeled.push(
          `<${el.tagName.toLowerCase()}> id=${id} placeholder=${el.getAttribute("placeholder")}`,
        );
      }
    });
    expect(unlabeled).toEqual([]);
  });

  it("ids are unique across the whole form (no duplicate DOM ids)", () => {
    const { container } = render(
      <BriefForm value={briefWithAllSections()} onChange={() => {}} />,
    );
    const ids = Array.from(
      container.querySelectorAll<HTMLElement>("[id]"),
    ).map((el) => el.getAttribute("id")!);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);
  });
});
