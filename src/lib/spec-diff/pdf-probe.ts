/**
 * pdf-probe - extract a PDF spec's text runs into the SAME SpecItem shape the
 * DOM probe (probes.ts collectItems) emits, so a PDF prototype flows through the
 * exact comparison pipeline (compareItems / summarize / evaluateAcceptance) that
 * an HTML prototype does. This is what lets a designer's PDF be a first-class
 * spec source, not just HTML.
 *
 * DRY with the retention/redaction work and with meeting-insights: unpdf is the
 * repo's PDF standard (pdfjs under the hood). unpdf's dynamic ES import cannot be
 * evaluated by ts-jest, so - exactly like meeting-insights/extractors/pdf.ts -
 * the doc reader is INJECTED. The default reads via unpdf; tests inject a
 * hermetic pdfjs-shaped stub to verify the coordinate mapping without the ESM
 * loader. The real parse is proven end to end against a real PDF separately.
 *
 * HONEST LIMITS (the mapping is geometry + size, not pixels):
 *  - PDF is fixed-layout POINTS; a web build is responsive px. Callers scale the
 *    page width to a target viewport before comparing (the integration's job).
 *  - pdfjs obfuscates font NAMES (g_d0_f1), so fontFamily is not reliable; font
 *    SIZE is. Weight/align are not recoverable, so they are left neutral.
 */
import type { SpecItem } from "./compare";

/** The minimal pdfjs page surface we need; a test can supply a stub. */
export interface PdfTextItem {
  str: string;
  /** pdfjs transform matrix [a,b,c,d,e,f]; e,f are x,y with a bottom-left origin. */
  transform: number[];
  width: number;
  height?: number;
  fontName?: string;
}
export interface PdfPage {
  getViewport(opts: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
}
export interface PdfDoc {
  getPage(n: number): Promise<PdfPage>;
}
export type PdfReader = (bytes: Uint8Array) => Promise<PdfDoc>;

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Map one page's pdfjs text items into SpecItems (top-left origin, px-as-points). */
export function itemsFromPage(page: { width: number; height: number }, textItems: PdfTextItem[]): SpecItem[] {
  const out: SpecItem[] = [];
  for (const it of textItems) {
    const str = (it.str ?? "").trim();
    if (!str) continue;
    const [, b, , d, e, f] = it.transform;
    const fontSize = round1(Math.hypot(b, d));
    const height = round1(it.height || fontSize);
    const width = round1(it.width ?? 0);
    if (width <= 0 || height <= 0 || fontSize <= 0) continue;
    out.push({
      tag: "pdf-text",
      text: str.slice(0, 60),
      top: round1(page.height - f - height), // flip bottom-left origin to top-left
      left: round1(e),
      width,
      height,
      fontSize,
      lineHeight: null, // not recoverable per text run from a PDF
      fontWeight: "normal",
      fontFamily: it.fontName ?? "unknown", // pdfjs obfuscates; not reliable
      textAlign: "left",
    });
  }
  return out;
}

/** Build a PDF collector over an injected reader (default = unpdf). */
export function makeCollectItemsFromPdf(reader: PdfReader) {
  return async function collectItemsFromPdf(bytes: Uint8Array): Promise<SpecItem[]> {
    const doc = await reader(bytes);
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const { items } = await page.getTextContent();
    return itemsFromPage(vp, items);
  };
}

const unpdfReader: PdfReader = async (bytes) => {
  const { getDocumentProxy } = await import("unpdf");
  return (await getDocumentProxy(bytes)) as unknown as PdfDoc;
};

/** Default collector: reads a real PDF via unpdf (pdfjs). */
export const collectItemsFromPdf = makeCollectItemsFromPdf(unpdfReader);
