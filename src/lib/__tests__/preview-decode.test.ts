/**
 * Preview draft base64 round-trip — UTF-8 must survive.
 *
 * Regression for the 2026-04-18 bug where the edit page's iframe
 * rendered "CFTR â€" Website Design Brief â€" Confidential..." instead
 * of "CFTR — Website Design Brief — Confidential...". The editor
 * encoded with btoa(unescape(encodeURIComponent(...))) but the
 * preview decoded with plain atob — which returns raw bytes as a JS
 * string, so multi-byte UTF-8 chars (en-dash "—" = 0xE2 0x80 0x94)
 * came back as latin-1 mojibake and JSON.parse produced a garbled
 * brief that RenderBrief then displayed verbatim.
 *
 * This test locks the symmetrical encode/decode contract — if anyone
 * changes the encoder to use a different scheme, the decoder must be
 * updated to match, and this test will catch it.
 */

import { decodeDraft } from "@/app/sites/[id]/preview/page";
import { type SiteBrief } from "@/lib/sites-schema";

// Mirror the editor-side encoder at
//   src/app/(dashboard)/sites/[id]/edit/page.tsx:398-412
function encodeDraft(brief: SiteBrief): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(brief))));
}

const BRIEF_WITH_UNICODE: SiteBrief = {
  client: "cftr",
  product: { name: "CFTR — Website Design Brief" },
  pages: [
    {
      route: "/",
      title: "Home",
      sections: [
        {
          type: "hero",
          heading: "AIDAN MULREADY — Ford Z-Tech Champion",
          body: "Nürburgring 24h · Season 2025 · “Podium or bust”",
        },
      ],
    },
  ],
};

describe("preview decodeDraft — UTF-8 round-trip", () => {
  it("round-trips the en-dash, umlaut, middle dot, and smart quotes", () => {
    const encoded = encodeDraft(BRIEF_WITH_UNICODE);
    const decoded = decodeDraft(encoded);

    expect(decoded.error).toBeNull();
    expect(decoded.brief).not.toBeNull();
    expect(decoded.brief!.product.name).toBe("CFTR — Website Design Brief");
    const hero = decoded.brief!.pages[0].sections[0] as {
      heading?: string;
      body?: string;
    };
    expect(hero.heading).toBe("AIDAN MULREADY — Ford Z-Tech Champion");
    expect(hero.body).toBe("Nürburgring 24h · Season 2025 · “Podium or bust”");
    // Negative assertion: no mojibake leaked through.
    const serialized = JSON.stringify(decoded.brief);
    expect(serialized).not.toMatch(/â€/);
    expect(serialized).not.toMatch(/Ã/);
  });

  it("returns null brief for an empty / missing draft", () => {
    const res = decodeDraft(null);
    expect(res.brief).toBeNull();
    expect(res.error).toBeNull();
  });

  it("surfaces a helpful error for invalid base64 / JSON", () => {
    const res = decodeDraft("not-really-base64!!!");
    expect(res.brief).toBeNull();
    expect(res.error).toMatch(/Draft could not be rendered/);
  });

  it("accepts URL-safe base64 as well (normalizes `-` / `_`)", () => {
    const encoded = encodeDraft(BRIEF_WITH_UNICODE);
    const urlSafe = encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const decoded = decodeDraft(urlSafe);
    expect(decoded.error).toBeNull();
    expect(decoded.brief!.product.name).toBe("CFTR — Website Design Brief");
  });
});
