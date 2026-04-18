/**
 * site-templates — library validation.
 *
 * Every exposed template must:
 *   - pass validateBrief() after applyTemplate
 *   - use only SUPPORTED_SECTION_TYPES
 *   - return a deep clone (mutating the result must NOT corrupt the lib)
 *   - set `client` to the slug passed to applyTemplate
 *   - resolve `{{slug}}` tokens in the returned brief
 *
 * Helper-only tests would be too easy to fake — these tests assert the
 * observable output of applyTemplate against the real validator imported
 * from sites-schema.
 */

import {
  SITE_TEMPLATES,
  applyTemplate,
  getTemplateById,
  listTemplates,
} from "@/lib/site-templates";
import { SUPPORTED_SECTION_TYPES, validateBrief } from "@/lib/sites-schema";

describe("site-templates library", () => {
  test("exposes at least the three launch templates by id", () => {
    const ids = SITE_TEMPLATES.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(["portfolio", "racing_team", "service_business"]));
    expect(ids.length).toBeGreaterThanOrEqual(3);
  });

  test("listTemplates returns a shallow metadata list (no brief payload leaking)", () => {
    const listed = listTemplates();
    expect(listed.length).toBe(SITE_TEMPLATES.length);
    for (const meta of listed) {
      expect(typeof meta.id).toBe("string");
      expect(typeof meta.name).toBe("string");
      expect(typeof meta.description).toBe("string");
      expect(typeof meta.thumbnail).toBe("string");
      expect((meta as unknown as { brief?: unknown }).brief).toBeUndefined();
    }
  });

  test("getTemplateById resolves known ids and returns undefined for unknown", () => {
    expect(getTemplateById("portfolio")?.id).toBe("portfolio");
    expect(getTemplateById("racing_team")?.id).toBe("racing_team");
    expect(getTemplateById("service_business")?.id).toBe("service_business");
    expect(getTemplateById("does-not-exist")).toBeUndefined();
  });

  test("applyTemplate returns null on unknown id", () => {
    expect(applyTemplate("nope", "acme-co")).toBeNull();
    expect(applyTemplate("", "acme-co")).toBeNull();
  });

  describe.each(SITE_TEMPLATES.map((t) => [t.id]))("template: %s", (id) => {
    const CLIENT_SLUG = "acme-co";

    test("applyTemplate returns a brief that passes validateBrief", () => {
      const result = applyTemplate(id as string, CLIENT_SLUG);
      expect(result).not.toBeNull();
      expect(() => validateBrief(result!.brief)).not.toThrow();
    });

    test("applyTemplate sets client to the given slug", () => {
      const { brief } = applyTemplate(id as string, CLIENT_SLUG)!;
      expect(brief.client).toBe(CLIENT_SLUG);
    });

    test("applyTemplate returns a deep clone — mutating the result does not corrupt the library", () => {
      const first = applyTemplate(id as string, CLIENT_SLUG)!;
      // Mutate every mutable surface we can reach.
      first.brief.product.name = "MUTATED";
      first.brief.pages[0].sections.push({ type: "text", heading: "injected" });
      if (first.brief.contactForm) {
        first.brief.contactForm.fields.push("INJECTED");
      }
      const second = applyTemplate(id as string, CLIENT_SLUG)!;
      expect(second.brief.product.name).not.toBe("MUTATED");
      const secondHasInjected = second.brief.pages[0].sections.some(
        (s) => s.heading === "injected",
      );
      expect(secondHasInjected).toBe(false);
      if (second.brief.contactForm) {
        expect(second.brief.contactForm.fields).not.toContain("INJECTED");
      }
    });

    test("applyTemplate resolves {{slug}} placeholders in product fields", () => {
      const { brief } = applyTemplate(id as string, CLIENT_SLUG)!;
      const joined = JSON.stringify(brief);
      expect(joined.includes("{{slug}}")).toBe(false);
      if (brief.product.domain) {
        // domain must be built from the slug (or an explicit non-slug value —
        // all current templates use {{slug}}.com).
        expect(brief.product.domain.includes(CLIENT_SLUG)).toBe(true);
      }
    });

    test("every section.type is one of SUPPORTED_SECTION_TYPES", () => {
      const { brief } = applyTemplate(id as string, CLIENT_SLUG)!;
      const known = new Set<string>(SUPPORTED_SECTION_TYPES);
      for (const page of brief.pages) {
        for (const section of page.sections) {
          expect(known.has(section.type)).toBe(true);
        }
      }
    });

    test("display_name is non-empty string", () => {
      const result = applyTemplate(id as string, CLIENT_SLUG)!;
      expect(typeof result.display_name).toBe("string");
      expect(result.display_name.length).toBeGreaterThan(0);
    });

    test("template has at least 4 pages OR 4 sections on the home page", () => {
      const { brief } = applyTemplate(id as string, CLIENT_SLUG)!;
      const home = brief.pages.find((p) => p.route === "/");
      const hasEnoughSections = (home?.sections.length ?? 0) >= 4;
      const hasEnoughPages = brief.pages.length >= 4;
      expect(hasEnoughSections || hasEnoughPages).toBe(true);
    });
  });

  test("racing_team template exercises the video section with an allowlisted host", () => {
    const { brief } = applyTemplate("racing_team", "acme-co")!;
    const home = brief.pages.find((p) => p.route === "/")!;
    const video = home.sections.find((s) => s.type === "video");
    expect(video).toBeDefined();
    expect(video!.videoUrl).toMatch(/^https:\/\/(www\.)?(youtube\.com|youtu\.be|vimeo\.com)/);
  });

  test("racing_team stats section has numeric values (validateBrief enforces type number)", () => {
    const { brief } = applyTemplate("racing_team", "acme-co")!;
    const home = brief.pages.find((p) => p.route === "/")!;
    const stats = home.sections.find((s) => s.type === "stats");
    expect(stats).toBeDefined();
    for (const item of stats!.items ?? []) {
      expect(typeof item.value).toBe("number");
    }
  });

  test("portfolio template includes a gallery with 4 images and a quote", () => {
    const { brief } = applyTemplate("portfolio", "acme-co")!;
    const home = brief.pages.find((p) => p.route === "/")!;
    const gallery = home.sections.find((s) => s.type === "gallery");
    const quote = home.sections.find((s) => s.type === "quote");
    expect(gallery).toBeDefined();
    expect(Array.isArray(gallery!.images)).toBe(true);
    expect(gallery!.images!.length).toBeGreaterThanOrEqual(4);
    expect(quote).toBeDefined();
  });

  test("service_business template includes /services and /contact pages", () => {
    const { brief } = applyTemplate("service_business", "acme-co")!;
    const routes = brief.pages.map((p) => p.route);
    expect(routes).toEqual(expect.arrayContaining(["/", "/services", "/contact"]));
  });
});
