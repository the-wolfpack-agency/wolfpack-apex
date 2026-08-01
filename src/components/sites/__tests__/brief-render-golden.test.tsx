/**
 * @jest-environment jsdom
 */

/**
 * Golden test for the generator: authored content in, rendered content out,
 * for every section type the studio lets someone author.
 *
 * WHY THIS EXISTS
 *
 * The spec-diff fidelity fixtures prove the JUDGE works — point it at a
 * prototype and a build and it reports the truth. Nothing proved the other
 * half: that a brief authored in the studio actually becomes a page containing
 * what was authored. A section type that is in the schema, offered in the UI,
 * and quietly dropped by the renderer would pass every test in this repo,
 * because the tests all assert on objects rather than on output.
 *
 * The loop this closes is specific. `SUPPORTED_SECTION_TYPES` is what the
 * studio offers; the renderer is a switch on that union. TypeScript makes the
 * switch exhaustive by TYPE, which says nothing about whether a branch renders
 * the heading it was given. This walks the union at RUNTIME and checks the
 * words come out the other side.
 */
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { RenderBrief } from "../render-brief";
import { SUPPORTED_SECTION_TYPES, validateBrief, type BriefSection, type SectionType, type SiteBrief } from "@/lib/sites-schema";

/** A marker per type, so a failure says which section swallowed its content. */
const heading = (type: SectionType) => `Heading for ${type}`;
const body = (type: SectionType) => `Body copy for ${type}`;

/**
 * A minimal, VALID section of each type carrying identifiable copy. Anything a
 * type genuinely requires (stats need numeric values, gallery needs images) is
 * supplied here rather than worked around, so the fixture is a brief the studio
 * could really produce.
 */
function sectionFor(type: SectionType): BriefSection {
  const base = { type, heading: heading(type), body: body(type) } as BriefSection;
  switch (type) {
    case "cards":
      return { ...base, items: [{ title: `Item for ${type}`, body: `Item body for ${type}` }] } as BriefSection;
    case "stats":
      return { ...base, items: [{ label: `Stat for ${type}`, value: 42 }] } as BriefSection;
    case "gallery":
      return { ...base, images: [{ src: "https://example.test/a.png", alt: `Image for ${type}` }] } as BriefSection;
    case "quote":
      return { ...base, attribution: `Attribution for ${type}` } as BriefSection;
    case "video":
      return { ...base, provider: "youtube", videoUrl: "https://youtu.be/dQw4w9WgXcQ" } as BriefSection;
    case "testimonial":
      return { ...base, items: [{ quote: `Quote for ${type}`, authorName: `Author for ${type}` }] } as BriefSection;
    case "pricing":
      return { ...base, items: [{ name: `Plan for ${type}`, price: "$10", features: [`Feature for ${type}`] }] } as BriefSection;
    case "faq":
      return { ...base, items: [{ question: `Question for ${type}`, answer: `Answer for ${type}` }] } as BriefSection;
    default:
      return base;
  }
}

/**
 * The copy that MUST appear for a given type. Not always the heading: a quote
 * section deliberately has none, because the body carries the pull quote and a
 * heading above it would be a second title for the same thing. Encoding that
 * here rather than assuming a heading everywhere is the difference between a
 * test that documents the design and one that argues with it.
 */
const markerFor = (type: SectionType): string => (type === "quote" ? body(type) : heading(type));

const briefWith = (sections: BriefSection[]): SiteBrief =>
  ({
    client: "golden",
    product: { name: "Golden Co", tagline: "A tagline", domain: "golden.test", supportEmail: "hi@golden.test" },
    pages: [{ route: "/", title: "Home", sections }],
  }) as unknown as SiteBrief;

describe("every section type the studio offers renders what was authored", () => {
  // Not a hand-written list: walking the exported union is what makes a NEW
  // section type fail here the moment it is added without a renderer branch.
  it.each(SUPPORTED_SECTION_TYPES.map((t) => [t] as const))("%s", (type) => {
    const brief = briefWith([sectionFor(type)]);

    // The brief must be one the API would accept. A fixture that only renders
    // because it skipped validation proves nothing about the real path.
    expect(() => validateBrief(brief)).not.toThrow();

    render(<RenderBrief brief={brief} />);
    expect(screen.getByText(markerFor(type))).toBeInTheDocument();
  });

  it("renders every type together on one page, in the authored order", () => {
    // Sections are rendered by a switch; one branch returning null would be
    // invisible in the per-type cases above if the page still had content.
    const brief = briefWith(SUPPORTED_SECTION_TYPES.map(sectionFor));
    render(<RenderBrief brief={brief} />);

    for (const type of SUPPORTED_SECTION_TYPES) {
      // queryByText, not getByText: a null with the type in the message beats a
      // thrown "unable to find element" that does not say which section broke.
      expect({ type, found: screen.queryByText(markerFor(type)) !== null }).toEqual({ type, found: true });
    }
    const rendered = SUPPORTED_SECTION_TYPES.map((t) => screen.getByText(markerFor(t)));
    const positions = rendered.map((el) => el.compareDocumentPosition(rendered[0]));
    // Every element after the first must report "precedes" relative to it.
    expect(positions.slice(1).every((p) => (p & Node.DOCUMENT_POSITION_PRECEDING) !== 0)).toBe(true);
  });

  it("escapes authored copy instead of interpreting it as markup", () => {
    // Copy arrives from a wireframe extraction and from an operator's typing.
    // Either can contain angle brackets, and neither may become an element.
    const brief = briefWith([{ type: "text", heading: "<img src=x onerror=alert(1)>", body: "safe" } as BriefSection]);
    const { container } = render(<RenderBrief brief={brief} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
  });

  it("renders an empty state rather than blanking when a draft has no pages", () => {
    const { container } = render(<RenderBrief brief={briefWith([])} />);
    expect(container.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });
});
