/**
 * A row of a spreadsheet means nothing without its column names.
 *
 * THE DEFECT, measured on the live corpus 2026-08-30. A survey export chunks
 * into 105 pieces and only the FIRST carries the header:
 *
 *   chunk  0  Sheet: Evaluation Responses
 *             Assessment Name,User ID,...,Class,Location,Prompt,Response
 *             2026 BA Program Evaluation,...,Conrad,...
 *   chunk  1  pporting your learning? ...","all of them were great...
 *   chunk  2  er Sales Professional,,6ff691aa,8/21/2026 15:27:12,...
 *
 * So a chunk full of hotel names has nothing saying those are LOCATIONS, and a
 * chunk full of free-text answers has nothing saying they are RESPONSES to a
 * question. The embedding sees a wall of commas.
 *
 * That is why "what feedback did we get about food and beverage" never finds
 * the survey it is obviously in. The words are there; the meaning is in a
 * header 104 chunks away.
 *
 * REPEATING THE HEADER IS THE WHOLE FIX. Each chunk becomes self-describing, at
 * the cost of one line per chunk, which is a rounding error against a 2,000
 * character budget and buys every row its column names back.
 *
 * IT TRACKS THE SHEET, because a workbook is several tables in a trench coat.
 * An export can hold "Evaluation Responses" and then "Export" with entirely
 * different columns, and stamping the first sheet's header onto the second
 * one's rows would be worse than stamping none: it would state something
 * false rather than merely omit something true.
 */

/** A sheet boundary as the extractor writes it. */
const SHEET_LINE = /^Sheet:\s*(.+)$/;

/**
 * A header row: several comma-separated fields, none of which look like data.
 *
 * Deliberately strict. Mistaking a data row for a header would stamp one
 * respondent's answers onto every chunk in the document, which is both wrong
 * and a privacy problem: their name would ride along on all 105.
 */
function looksLikeHeader(line: string): boolean {
  const cells = line.split(",");
  if (cells.length < 3) return false;

  const isLabel = (cell: string): boolean => {
    const v = cell.trim().replace(/^"|"$/g, "");
    if (v.length === 0 || v.length > 40) return false;
    /* A header cell is a label: letters and spaces, no sentences, no digits
       carrying values, no timestamps, no quoted free text. */
    return /^[A-Za-z][A-Za-z _/-]*$/.test(v);
  };

  /* THE FIRST CELL DECIDES A LOT. A header opens on a column name; the survey
     rows that fooled an earlier version of this opened on "2026 BA Program
     Evaluation", which is a value. */
  if (!isLabel(cells[0])) return false;

  /* NEARLY ALL OF THEM, NOT MERELY MOST. At 60 per cent a real data row
     passed: "2026 BA Program Evaluation,1bcec47b-e59d-4288,Joseph,Bacus,
     ACTIVE,jbacus" has four label-shaped cells out of six, because names and
     status codes look exactly like column names.
     That false positive is the expensive one. It would stamp one
     respondent's name and status onto all 105 chunks of the document: wrong
     on every chunk, and their identity carried into places it never was. */
  const named = cells.filter(isLabel).length;
  return named >= Math.max(3, Math.ceil(cells.length * 0.8));
}

export interface TableContext {
  /** The sheet name, when the extractor emitted one. */
  sheet: string | null;
  /** The column header row. */
  header: string;
}

/**
 * Find the table context in force at the start of some text.
 *
 * Returns null when the text is not tabular, which is the common case and must
 * stay cheap: this runs over every block of every document ingested.
 */
export function readTableContext(text: string): TableContext | null {
  const lines = text.split("\n");
  let sheet: string | null = null;

  for (let i = 0; i < Math.min(lines.length, 6); i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const sheetMatch = SHEET_LINE.exec(line);
    if (sheetMatch) {
      sheet = sheetMatch[1].trim();
      continue;
    }
    if (looksLikeHeader(line)) return { sheet, header: line };
    /* A non-header, non-sheet line this early means the document is prose. */
    if (!sheetMatch) break;
  }
  return null;
}

/** How the context is written onto a chunk that does not already carry it. */
export function renderContext(ctx: TableContext): string {
  return ctx.sheet ? `Sheet: ${ctx.sheet}\n${ctx.header}` : ctx.header;
}

/**
 * Give every chunk of a tabular document its column names back.
 *
 * Walks the chunks in order, tracking the sheet and header currently in force,
 * and prefixes any chunk that does not already begin with them. A chunk that
 * already opens on its header is left exactly as it is, so re-running this is
 * harmless and the first chunk of each sheet is untouched.
 */
export function applyTableHeaders(chunks: string[]): string[] {
  let ctx: TableContext | null = null;

  return chunks.map((chunk) => {
    const own = readTableContext(chunk);

    /* ONLY A NEW SHEET REPLACES THE CONTEXT.
     *
     * Within one sheet the columns never change, so a mid-document line that
     * merely LOOKS like a header must not override the real one. Rows of
     * short values do look like headers: "Motor Springs,Conrad,Ritz Carlton"
     * is six label-shaped cells and nothing about its shape says otherwise.
     *
     * Anchoring the replacement on an explicit "Sheet:" line removes the
     * guesswork, because that is the one marker the extractor emits and a data
     * row never carries. Before this, one such row silently stopped every
     * chunk after it from getting its header. */
    if (own && own.sheet !== null) {
      ctx = own;
      return chunk;
    }

    /* The document's FIRST header, on an export with no sheet line. */
    if (own && ctx === null) {
      ctx = own;
      return chunk;
    }

    if (!ctx) return chunk;
    /* Already carries it, so re-running is harmless. */
    if (chunk.startsWith(renderContext(ctx))) return chunk;
    return `${renderContext(ctx)}\n${chunk}`;
  });
}
