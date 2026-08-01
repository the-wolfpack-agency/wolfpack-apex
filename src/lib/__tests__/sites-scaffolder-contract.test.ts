/**
 * The gap between what the studio can author and what the deploy target can
 * build, pinned as a value.
 *
 * The failing case here is not a hypothetical. Adding video, testimonial,
 * pricing and faq to this repo's schema, with renderers and a preview, made
 * them authorable and previewable. The scaffolder in wolfpack-site-template was
 * never taught them, and it exits non-zero on an unknown type, so those briefs
 * deploy-fail. Nothing in either repo said so.
 *
 * These tests do two things: they state the gap out loud so it is reviewable,
 * and they make it impossible to WIDEN accidentally. A thirteenth section type
 * added here without a matching scaffolder change fails the second test.
 */
import { SUPPORTED_SECTION_TYPES } from "../sites-schema";
import { SCAFFOLDER_SECTION_TYPES, unbuildableSectionTypes, canScaffold, SCAFFOLDER_SOURCE } from "../sites-scaffolder-contract";

describe("studio capability vs deploy-target capability", () => {
  it("records that the deploy target can now build everything the studio offers", () => {
    // Was ["video","testimonial","pricing","faq"] until wolfpack-site-template
    // PR #1 implemented them. Written out rather than computed, so a change is
    // a decision someone makes on purpose and a reviewer sees in the diff.
    expect(unbuildableSectionTypes()).toEqual([]);
  });

  it("cannot widen without someone editing this test", () => {
    // The guardrail. A new section type added to the schema lands here as a
    // failure that says "the template cannot build this yet", which is the
    // conversation that did not happen when the last four were added.
    expect(unbuildableSectionTypes().length).toBe(SUPPORTED_SECTION_TYPES.length - SCAFFOLDER_SECTION_TYPES.length);
    expect(SUPPORTED_SECTION_TYPES.length).toBe(12);
    expect(SCAFFOLDER_SECTION_TYPES.length).toBe(12);
  });

  it("the mirrored list is a subset of what the studio offers", () => {
    // A type the scaffolder knows and the studio does not would mean the mirror
    // has drifted the other way, or that a type was removed here in error.
    for (const t of SCAFFOLDER_SECTION_TYPES) expect(SUPPORTED_SECTION_TYPES).toContain(t);
  });

  it("names where the mirrored list came from, so it can be re-checked in one hop", () => {
    expect(SCAFFOLDER_SOURCE).toEqual({
      repo: "the-wolfpack-agency/wolfpack-site-template",
      file: "scripts/scaffold-client-site.mjs",
      symbol: "knownTypes",
    });
  });

  describe("canScaffold", () => {
    it("passes a brief the target can build", () => {
      expect(canScaffold(["hero", "text", "cards"])).toEqual({ ok: true, unsupported: [] });
    });

    it("passes the four types that used to fail the deploy", () => {
      expect(canScaffold(["video", "testimonial", "pricing", "faq"])).toEqual({ ok: true, unsupported: [] });
    });

    it("still names anything unbuildable, deduplicated", () => {
      // The guard has to keep working for the NEXT divergence, not just be
      // switched off because today's gap closed.
      const unknown = ["hero", "carousel", "faq", "carousel"] as unknown as Parameters<typeof canScaffold>[0];
      expect(canScaffold(unknown)).toEqual({ ok: false, unsupported: ["carousel"] });
    });

    it("is fine with an empty brief", () => {
      expect(canScaffold([])).toEqual({ ok: true, unsupported: [] });
    });
  });
});
