/**
 * Read a PowerPoint deck.
 *
 * WHY THIS EXISTS. Measured on production 2026-08-27: 75 .pptx files in the
 * Brain, and not one of them had a single chunk. There was no pptx kind and no
 * extractor, so they classified as "other" and were skipped at ingest. A
 * client library full of training decks was fully invisible to every question
 * asked of it, while the UI happily listed the files.
 *
 * That matters more than the count suggests. Decks are where the material
 * somebody actually teaches from lives, so "what does the training say about
 * X" is exactly the question these files answer and exactly the one that came
 * back empty.
 *
 * NO NEW DEPENDENCY. A .pptx is a ZIP, the same as a .docx, and the docx path
 * here already proved that regex over the part XML beats pulling in a parser:
 * mammoth broke against this repo's xmldom override and took every Word
 * document down with it. JSZip is already in the tree.
 *
 * SPEAKER NOTES ARE INCLUDED, and they are often the point. A slide reads
 * "Signature moments" in 40pt and the notes carry the paragraph explaining
 * what that means. Indexing only the slide face would retrieve the title and
 * lose the substance.
 *
 * SLIDE NUMBERS ARE KEPT so a citation can say where it came from. "Slide 12
 * of the BA101 deck" is checkable; an unattributed sentence is not.
 */

/** Text runs in DrawingML, on both slides and notes. */
const TEXT_RUN_RE = /<a:t>([\s\S]*?)<\/a:t>/g;
/** Paragraph boundaries, so two bullets do not run into one sentence. */
const PARA_SPLIT_RE = /<a:p\b[^>]*>/;

/** `ppt/slides/slide12.xml` → 12. Used to order numerically. */
function slideNumber(path: string): number {
  const m = /slide(\d+)\.xml$/i.exec(path);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    /* Ampersand last, or "&amp;lt;" would become "<". */
    .replace(/&amp;/g, "&");
}

/**
 * One slide's XML into readable lines.
 *
 * Exported so the shape can be tested without building a real .pptx, which is
 * how the docx converter next door is tested too.
 */
export function slideXmlToText(xml: string): string {
  const lines: string[] = [];
  /* Split on paragraphs first so bullets stay separate. Runs inside one
     paragraph are joined without a space, because PowerPoint splits a single
     word across runs whenever formatting changes mid-word. */
  for (const para of xml.split(PARA_SPLIT_RE)) {
    TEXT_RUN_RE.lastIndex = 0;
    let text = "";
    let m: RegExpExecArray | null;
    while ((m = TEXT_RUN_RE.exec(para)) !== null) text += m[1];
    const clean = decodeEntities(text).replace(/\s+/g, " ").trim();
    if (clean) lines.push(clean);
  }
  return lines.join("\n");
}

/**
 * A .pptx buffer into text, slide by slide.
 *
 * Returns an empty string when the deck genuinely carries no text, which is a
 * real case: a deck of exported images has nothing to read. The caller reports
 * that as "no extractable text" rather than as a parse failure, because the
 * two need different fixes and OCR is the answer to only one of them.
 */
export async function pptxBufferToText(buf: Buffer): Promise<string> {
  /* Dynamic import: JSZip is a CommonJS module surfaced transitively, and a
     top-level import forces it into the build. Same reasoning as the docx
     path. */
  const JSZipMod = (await import("jszip")).default;
  const zip = await JSZipMod.loadAsync(buf);

  const slidePaths = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/i.test(f))
    /* Numeric, not lexical. Lexical puts slide10 before slide2 and scrambles
       a deck whose whole meaning is its order. */
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  if (slidePaths.length === 0) {
    throw new Error("not a valid .pptx (no slides found)");
  }

  const out: string[] = [];
  for (const path of slidePaths) {
    const n = slideNumber(path);
    const body = slideXmlToText(await zip.files[path].async("string"));

    /* Notes live in a parallel part with the same number. Absent for most
       slides, which is normal and not an error. */
    const notesFile = zip.files[`ppt/notesSlides/notesSlide${n}.xml`];
    const notes = notesFile ? slideXmlToText(await notesFile.async("string")) : "";

    if (!body && !notes) continue;

    /* The heading is what makes a citation checkable later. */
    out.push(`## Slide ${n}`);
    if (body) out.push(body);
    if (notes) out.push(`Speaker notes: ${notes}`);
  }

  return out.join("\n\n").trim();
}
