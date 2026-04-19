/**
 * brief-exemplars tests.
 *
 * Covers: pure summarizeGeneration mapping, exemplarsToPromptBlock
 * rendering + length cap, and the DB-pathed getAcceptedExemplars with a
 * mocked safeQuery. Analytics are mocked so we can assert the
 * served/empty events are wired correctly without hitting the DB pool.
 */

const mockSafeQuery = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/db", () => ({
  safeQuery: (...args: unknown[]) => mockSafeQuery(...args),
  query: jest.fn(),
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

import {
  getAcceptedExemplars,
  exemplarsToPromptBlock,
  summarizeGeneration,
  type BriefExemplar,
} from "@/lib/brief-exemplars";
import type { SiteBrief } from "@/lib/sites-schema";

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function fullBrief(overrides: Partial<SiteBrief> = {}): SiteBrief {
  return {
    client: "cftr",
    product: { name: "CFTR Racing", tagline: "Nürburgring 24h Campaign" },
    pages: [
      {
        route: "/",
        sections: [
          {
            type: "hero",
            heading: "AIDAN MULREADY",
            cta: { label: "Partner With Us", href: "/contact" },
          },
          { type: "stats", items: [{ label: "Laps", value: 120 }] },
          { type: "gallery", images: [{ src: "/a.jpg" }] },
          { type: "cards", items: [{ title: "Feature" }] },
          { type: "testimonial", items: [{ quote: "Great", authorName: "X" }] },
        ],
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
});

/* ---------------------------- summarizeGeneration --------------------- */

describe("summarizeGeneration", () => {
  it("populates every field from a full-shape brief", () => {
    const row = {
      extracted_brief: fullBrief(),
      extracted_colors: ["#0a0a0a", "#bfa46f", "#f5f5f5"],
      detected_font: "Inter",
      created_at: isoDaysAgo(14),
    };
    const e = summarizeGeneration(row);
    expect(e).not.toBeNull();
    expect(e!.client).toBe("cftr");
    expect(e!.productName).toBe("CFTR Racing");
    expect(e!.tagline).toBe("Nürburgring 24h Campaign");
    expect(e!.sectionTypes).toEqual([
      "hero",
      "stats",
      "gallery",
      "cards",
      "testimonial",
    ]);
    expect(e!.heroHeading).toBe("AIDAN MULREADY");
    expect(e!.primaryCta).toBe("Partner With Us");
    expect(e!.paletteHex).toEqual(["#0a0a0a", "#bfa46f", "#f5f5f5"]);
    expect(e!.font).toBe("Inter");
    expect(e!.createdAt).toBe(row.created_at);
  });

  it("returns null tagline (not undefined) when missing", () => {
    const brief = fullBrief();
    delete (brief.product as { tagline?: string }).tagline;
    const e = summarizeGeneration({
      extracted_brief: brief,
      extracted_colors: null,
      detected_font: null,
      created_at: isoDaysAgo(1),
    });
    expect(e).not.toBeNull();
    expect(e!.tagline).toBeNull();
  });

  it("returns null heroHeading when no hero section exists anywhere", () => {
    const brief: SiteBrief = {
      client: "acme",
      product: { name: "Acme" },
      pages: [
        {
          route: "/",
          sections: [
            { type: "text", body: "hello" },
            { type: "cards", items: [{ title: "c" }] },
          ],
        },
      ],
    };
    const e = summarizeGeneration({
      extracted_brief: brief,
      extracted_colors: null,
      detected_font: null,
      created_at: isoDaysAgo(1),
    });
    expect(e!.heroHeading).toBeNull();
  });

  it("picks first CTA encountered across multiple pages/sections", () => {
    const brief: SiteBrief = {
      client: "acme",
      product: { name: "Acme" },
      pages: [
        {
          route: "/",
          sections: [
            { type: "hero", heading: "Hi" },
            {
              type: "callout",
              cta: { label: "First CTA", href: "/x" },
            },
          ],
        },
        {
          route: "/about",
          sections: [
            { type: "text", body: "more" },
            { type: "banner", cta: { label: "Second CTA", href: "/y" } },
          ],
        },
      ],
    };
    const e = summarizeGeneration({
      extracted_brief: brief,
      extracted_colors: null,
      detected_font: null,
      created_at: isoDaysAgo(1),
    });
    expect(e!.primaryCta).toBe("First CTA");
  });

  it("returns null when product.name is missing", () => {
    const brief = {
      client: "acme",
      product: {}, // no name
      pages: [{ route: "/", sections: [] }],
    };
    const e = summarizeGeneration({
      extracted_brief: brief,
      extracted_colors: null,
      detected_font: null,
      created_at: isoDaysAgo(1),
    });
    expect(e).toBeNull();
  });

  it("parses extracted_brief when stored as a JSON string", () => {
    const brief = fullBrief();
    const e = summarizeGeneration({
      extracted_brief: JSON.stringify(brief),
      extracted_colors: ["#111111"],
      detected_font: "Helvetica",
      created_at: isoDaysAgo(3),
    });
    expect(e).not.toBeNull();
    expect(e!.productName).toBe("CFTR Racing");
    expect(e!.paletteHex).toEqual(["#111111"]);
  });

  it("trims palette to a max of 5 colors", () => {
    const e = summarizeGeneration({
      extracted_brief: fullBrief(),
      extracted_colors: [
        "#000001",
        "#000002",
        "#000003",
        "#000004",
        "#000005",
        "#000006",
        "#000007",
      ],
      detected_font: null,
      created_at: isoDaysAgo(1),
    });
    expect(e!.paletteHex).toHaveLength(5);
    expect(e!.paletteHex).toEqual([
      "#000001",
      "#000002",
      "#000003",
      "#000004",
      "#000005",
    ]);
  });

  it("preserves null font when detected_font is null", () => {
    const e = summarizeGeneration({
      extracted_brief: fullBrief(),
      extracted_colors: null,
      detected_font: null,
      created_at: isoDaysAgo(1),
    });
    expect(e!.font).toBeNull();
  });
});

/* ---------------------------- exemplarsToPromptBlock ------------------ */

describe("exemplarsToPromptBlock", () => {
  function buildExemplar(overrides: Partial<BriefExemplar> = {}): BriefExemplar {
    return {
      client: "cftr",
      productName: "CFTR Racing",
      tagline: "Nürburgring 24h Campaign",
      sectionTypes: ["hero", "stats", "gallery"],
      heroHeading: "AIDAN MULREADY",
      primaryCta: "Partner With Us",
      paletteHex: ["#0a0a0a", "#bfa46f"],
      font: "Inter",
      createdAt: isoDaysAgo(14),
      ...overrides,
    };
  }

  it("returns empty string for empty array", () => {
    expect(exemplarsToPromptBlock([])).toBe("");
  });

  it("renders one exemplar with product name, days-ago, palette, hero heading", () => {
    const block = exemplarsToPromptBlock([buildExemplar()]);
    expect(block).toContain("CFTR Racing");
    expect(block).toContain("AIDAN MULREADY");
    expect(block).toContain("#0a0a0a");
    expect(block).toContain("#bfa46f");
    expect(block).toContain("14 days ago");
    expect(block).toContain("PRIOR ACCEPTED BRIEFS");
  });

  it("truncates a >80-char tagline to 80 chars", () => {
    const longTagline = "x".repeat(200);
    const block = exemplarsToPromptBlock([
      buildExemplar({ tagline: longTagline }),
    ]);
    // find the tagline segment in the block
    const match = block.match(/tagline "([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBeLessThanOrEqual(80);
  });

  it("drops tail exemplars when 5 of them exceed 2000 chars", () => {
    const bigTagline = "y".repeat(60);
    const manySections = Array.from({ length: 50 }, () => "hero");
    const exemplars: BriefExemplar[] = Array.from({ length: 5 }, (_, i) =>
      buildExemplar({
        productName: `Product ${i}-${"z".repeat(40)}`,
        tagline: bigTagline,
        sectionTypes: manySections,
        heroHeading: "h".repeat(60),
        primaryCta: "c".repeat(60),
        paletteHex: ["#111111", "#222222", "#333333", "#444444", "#555555"],
        font: "Helvetica Neue",
        createdAt: isoDaysAgo(i + 1),
      }),
    );
    const block = exemplarsToPromptBlock(exemplars);
    expect(block.length).toBeLessThanOrEqual(2000);
    // the head (index 1.) should have survived; tail may have been dropped
    expect(block).toContain("1.");
  });
});

/* ---------------------------- getAcceptedExemplars -------------------- */

describe("getAcceptedExemplars", () => {
  it("summarizes rows in order when 3 are returned", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          extracted_brief: fullBrief({
            product: { name: "One" },
          }),
          extracted_colors: ["#111111"],
          detected_font: "Inter",
          created_at: isoDaysAgo(1),
        },
        {
          extracted_brief: fullBrief({
            product: { name: "Two" },
          }),
          extracted_colors: null,
          detected_font: null,
          created_at: isoDaysAgo(3),
        },
        {
          extracted_brief: fullBrief({
            product: { name: "Three" },
          }),
          extracted_colors: ["#222222", "#333333"],
          detected_font: "Roboto",
          created_at: isoDaysAgo(5),
        },
      ],
      fromCache: false,
    });

    const out = await getAcceptedExemplars({ clientSlug: "cftr" });
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.productName)).toEqual(["One", "Two", "Three"]);
    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(sql).toContain("apex_site_brief_generations");
    expect(sql).toContain("apex_site_projects");
    expect(sql).toContain("accepted = true");
    expect(sql).toContain("client_slug = $1");
    expect(params[0]).toBe("cftr");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "site.brief_exemplars_served",
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        client_slug: "cftr",
        exemplar_count: 3,
      }),
    );
  });

  it("filters out rows with missing product.name before counting toward limit", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          extracted_brief: { client: "cftr", product: {}, pages: [] }, // no name
          extracted_colors: null,
          detected_font: null,
          created_at: isoDaysAgo(1),
        },
        {
          extracted_brief: fullBrief({ product: { name: "Kept" } }),
          extracted_colors: null,
          detected_font: null,
          created_at: isoDaysAgo(2),
        },
      ],
      fromCache: false,
    });
    const out = await getAcceptedExemplars({ clientSlug: "cftr" });
    expect(out).toHaveLength(1);
    expect(out[0].productName).toBe("Kept");
  });

  it("returns [] (never throws) when safeQuery throws", async () => {
    mockSafeQuery.mockRejectedValueOnce(new Error("connection refused"));
    const out = await getAcceptedExemplars({ clientSlug: "cftr" });
    expect(out).toEqual([]);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "site.brief_exemplars_empty",
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        client_slug: "cftr",
        reason: "no_accepted_generations",
      }),
    );
  });

  it("caps limit at 5 when caller asks for 10", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    await getAcceptedExemplars({ clientSlug: "cftr", limit: 10 });
    const [, params] = mockSafeQuery.mock.calls[0];
    // params: [clientSlug, minAgeDays, maxAgeDays, limit]
    expect(params[3]).toBe(5);
  });

  it("respects a smaller caller-supplied limit", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          extracted_brief: fullBrief({ product: { name: "A" } }),
          extracted_colors: null,
          detected_font: null,
          created_at: isoDaysAgo(1),
        },
        {
          extracted_brief: fullBrief({ product: { name: "B" } }),
          extracted_colors: null,
          detected_font: null,
          created_at: isoDaysAgo(2),
        },
      ],
      fromCache: false,
    });
    const out = await getAcceptedExemplars({ clientSlug: "cftr", limit: 2 });
    expect(out.length).toBeLessThanOrEqual(2);
    const [, params] = mockSafeQuery.mock.calls[0];
    expect(params[3]).toBe(2);
  });

  it("returns [] and fires exemplars_empty when query returns no rows", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    const out = await getAcceptedExemplars({
      clientSlug: "unknown",
      userId: "u_123",
      userRole: "designer",
    });
    expect(out).toEqual([]);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "site.brief_exemplars_empty",
      "u_123",
      "designer",
      expect.objectContaining({
        client_slug: "unknown",
        reason: "no_accepted_generations",
      }),
    );
  });
});
