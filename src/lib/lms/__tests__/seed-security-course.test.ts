/**
 * The security course spec is derived purely from the build's single source of
 * truth (security-plain-language.ts). This pins that projection: the ladder,
 * the modules (products + deep dives + acquisitions), and that every lesson
 * carries the four plain-language beats as typed blocks.
 */
import { buildSecurityCourseSpec, SECURITY_COURSE_SLUG } from "@/lib/lms/seed-security-course";
import { CERT_TIERS, PRODUCTS, DEEP_DIVES, ACQUISITIONS } from "@/lib/builds/security-plain-language";

describe("buildSecurityCourseSpec", () => {
  const spec = buildSecurityCourseSpec();

  it("uses the stable slug and carries the ladder as tracks", () => {
    expect(spec.slug).toBe(SECURITY_COURSE_SLUG);
    expect(spec.tracks.map((t) => t.name)).toEqual(CERT_TIERS.map((t) => t.tier));
    expect(spec.tracks.every((t) => t.audience && t.proves)).toBe(true);
  });

  it("makes a module for the product line, each deep dive, acquisitions, and the higher tiers", () => {
    // products + one per deep dive + acquisitions + practitioner + ambassador
    expect(spec.modules).toHaveLength(1 + DEEP_DIVES.length + 1 + 2);
    const titles = spec.modules.map((m) => m.title);
    for (const d of DEEP_DIVES) expect(titles).toContain(d.product);
    expect(titles.some((t) => /Practitioner/.test(t))).toBe(true);
    expect(titles.some((t) => /Ambassador/.test(t))).toBe(true);
  });

  it("turns every product into a lesson with all four beats as blocks", () => {
    const productModule = spec.modules[0];
    expect(productModule.lessons).toHaveLength(PRODUCTS.length);
    for (const lesson of productModule.lessons) {
      const kinds = lesson.blocks.map((b) => b.type);
      expect(kinds).toEqual(["glossary", "plain", "stops", "without"]);
      // the plain-language beat stays plain (mirrors the content contract)
      const plain = lesson.blocks.find((b) => b.type === "plain");
      expect(plain && "text" in plain && plain.text.length).toBeGreaterThan(60);
    }
  });

  it("carries every acquisition as a lesson too", () => {
    const acq = spec.modules.find((m) => /acquisitions/i.test(m.title))!;
    expect(acq.lessons).toHaveLength(ACQUISITIONS.length);
    expect(acq.lessons[0].blocks.map((b) => b.type)).toEqual(["text", "plain", "stops", "without"]);
  });

  it("carries the Practitioner objection-handling plays as lessons", () => {
    const prac = spec.modules.find((m) => /Practitioner/.test(m.title))!;
    expect(prac.lessons.length).toBeGreaterThanOrEqual(3);
    // each play ends on the plain-language answer
    expect(prac.lessons[0].blocks[prac.lessons[0].blocks.length - 1].type).toBe("plain");
  });
});
