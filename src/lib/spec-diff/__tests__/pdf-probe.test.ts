/** pdf-probe: a PDF spec's text runs become SpecItems that flow through the SAME
 *  comparison the DOM probe feeds. Hermetic (injected pdfjs-shaped stub) so the
 *  coordinate mapping is verified without unpdf's ESM loader; the real parse is
 *  proven against a real PDF separately. */
import { itemsFromPage, makeCollectItemsFromPdf, type PdfDoc } from "../pdf-probe";
import { compareItems } from "../compare";

// A pdfjs page is 612x792 pt (US Letter); origin is BOTTOM-left.
const PAGE = { width: 612, height: 792 };
const textItems = [
  { str: "Hero Headline", transform: [26, 0, 0, 26, 50, 740], width: 200, height: 26, fontName: "g_d0_f1" },
  { str: "body copy", transform: [12, 0, 0, 12, 50, 700], width: 120, height: 12, fontName: "g_d0_f2" },
  { str: "   ", transform: [12, 0, 0, 12, 50, 680], width: 10, height: 12, fontName: "g_d0_f2" }, // whitespace -> dropped
];

describe("itemsFromPage", () => {
  it("maps pdfjs text runs into SpecItems with a top-left origin + real geometry", () => {
    const items = itemsFromPage(PAGE, textItems);
    expect(items).toHaveLength(2); // whitespace run dropped
    const hero = items[0];
    expect(hero.text).toBe("Hero Headline");
    expect(hero.left).toBe(50);
    expect(hero.fontSize).toBe(26);
    // top = pageHeight - y - height = 792 - 740 - 26 = 26
    expect(hero.top).toBe(26);
    expect(hero.width).toBe(200);
    expect(hero.tag).toBe("pdf-text");
  });
  it("drops zero-width / zero-size runs (nothing to measure)", () => {
    expect(itemsFromPage(PAGE, [{ str: "x", transform: [1, 0, 0, 1, 0, 0], width: 0, height: 0 }])).toHaveLength(0);
  });
});

describe("collectItemsFromPdf (injected reader) flows through compareItems", () => {
  const stubDoc: PdfDoc = {
    getPage: async () => ({
      getViewport: () => PAGE,
      getTextContent: async () => ({ items: textItems }),
    }),
  };
  it("PDF-sourced SpecItems self-compare clean (prove they feed the existing pipeline)", async () => {
    const collect = makeCollectItemsFromPdf(async () => stubDoc);
    const items = await collect(new Uint8Array());
    expect(items.length).toBeGreaterThan(0);
    const result = compareItems(items, items);
    expect(result.diffs).toHaveLength(0);
    expect(result.matched).toBe(items.length);
  });
});
