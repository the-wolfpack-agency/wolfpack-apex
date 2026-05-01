/**
 * Cost-budget xlsx I/O — round-trips a WPA Cost Budget Template through
 * the canonical model.
 *
 * Pure-function design: parse() consumes Uint8Array → ParsedBudget,
 * build() consumes BudgetRecord+lines+rollup → Uint8Array. The store
 * (DB) lives elsewhere; the API route bridges them. This makes both
 * functions trivially testable with the real WPA file.
 *
 * No new runtime dependencies — JSZip is already in the tree (used by
 * the principles parser). Exports use a hand-built minimal xlsx that
 * Excel and Google Sheets both open without complaint; we don't need
 * formulas because the canonical model already pre-computes totals.
 */

/* Column convention from the WPA template:
     A = Resp        E = Name
     B = Cost Code   J = Units
     C = Line #      K = Rate
     D = Description L = Total                                    */

import JSZip from "jszip";

export interface ParsedBudgetSpecs {
  jobName: string | null;
  jobNumber: string | null;
  version: string | null;
  weeks: number | null;
  prepEventDays: number | null;
  markets: number | null;
  eventDays: number | null;
  teams: number | null;
  hotel: number | null;
  ballroom: number | null;
  breakoutRooms: number | null;
  tents: number | null;
  clearSpanFrame: number | null;
  vehicles: number | null;
  staticDisplay: number | null;
  drive: number | null;
  competitors: number | null;
}

export interface ParsedBudgetLine {
  /** Section header (matches `instinct_program_budget_categories.name`,
   *  case-insensitive). */
  category: string;
  costCode: number | null;
  responsible: string | null;
  lineNumber: string | null;
  description: string | null;
  name: string | null;
  units: number;
  rate: number;
  total: number;
}

export interface ParsedBudget {
  specs: ParsedBudgetSpecs;
  lines: ParsedBudgetLine[];
  warnings: string[];
}

interface CellMap {
  [col: string]: string;
}

interface XlsxRow {
  rowNum: number;
  cells: CellMap;
}

function cleanXmlText(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  const tRegex = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = siRegex.exec(xml))) {
    const inner = m[1];
    let collected = "";
    let tm: RegExpExecArray | null;
    while ((tm = tRegex.exec(inner))) {
      collected += tm[1];
    }
    out.push(cleanXmlText(collected));
  }
  return out;
}

function colOf(ref: string): string {
  return ref.replace(/[0-9]/g, "");
}

function parseSheetRows(xml: string, strings: string[]): XlsxRow[] {
  const rowRegex = /<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  /* Two cell forms in xlsx:
       1) self-closing  <c r="A46" s="13"/>           — no value
       2) full          <c r="B46" t="s"><v>63</v></c> — has value
     A single regex that lazily matches `</c>` is broken: when we hit a
     self-closing cell first, `[\s\S]*?</c>` happily eats until the
     NEXT real `</c>`, swallowing whatever cells were in between. So we
     match both forms in one alternation and pick the shape per hit. */
  const cellRegex =
    /<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g;
  const refRegex = /\br="([A-Z]+\d+)"/;
  const tRegex = /\bt="([^"]*)"/;
  const out: XlsxRow[] = [];
  let r: RegExpExecArray | null;
  while ((r = rowRegex.exec(xml))) {
    const rowNum = Number(r[1]);
    const inner = r[2];
    const cells: CellMap = {};
    let c: RegExpExecArray | null;
    cellRegex.lastIndex = 0;
    while ((c = cellRegex.exec(inner))) {
      const attrs = c[1] ?? c[2] ?? "";
      const body = c[3] ?? "";
      const refM = refRegex.exec(attrs);
      if (!refM) continue;
      const ref = refM[1];
      const tM = tRegex.exec(attrs);
      const t = tM ? tM[1] : undefined;
      let val: string | null = null;
      if (body) {
        const vMatch = /<v[^>]*>([\s\S]*?)<\/v>/.exec(body);
        const isMatch = /<is[^>]*>([\s\S]*?)<\/is>/.exec(body);
        if (t === "s" && vMatch) {
          val = strings[Number(vMatch[1])] ?? null;
        } else if (t === "inlineStr" && isMatch) {
          const tm = /<t[^>]*>([\s\S]*?)<\/t>/.exec(isMatch[1]);
          val = tm ? cleanXmlText(tm[1]) : null;
        } else if (vMatch) {
          val = vMatch[1];
        }
      }
      if (val !== null) cells[colOf(ref)] = val;
    }
    if (Object.keys(cells).length > 0) out.push({ rowNum, cells });
  }
  return out;
}

function num(v: string | undefined | null): number {
  if (v === undefined || v === null || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: string | undefined | null): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v: string | undefined | null): string | null {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t ? t : null;
}

const SPEC_LABEL_TO_FIELD: Record<string, keyof ParsedBudgetSpecs> = {
  weeks: "weeks",
  "prep/event days": "prepEventDays",
  markets: "markets",
  "event days": "eventDays",
  teams: "teams",
  hotel: "hotel",
  ballroom: "ballroom",
  "breakout rooms": "breakoutRooms",
  tents: "tents",
  "clear-span": "clearSpanFrame",
  frame: "clearSpanFrame",
  vehicles: "vehicles",
  "static display": "staticDisplay",
  drive: "drive",
  competitors: "competitors",
};

/** Parse a WPA xlsx into the canonical model. Pure — no DB access. */
export async function parseBudgetXlsx(
  bytes: Uint8Array | Buffer,
): Promise<ParsedBudget> {
  const zip = await JSZip.loadAsync(bytes);
  const ssFile = zip.file("xl/sharedStrings.xml");
  const sheetFile =
    zip.file("xl/worksheets/sheet1.xml") ||
    zip.file(/xl\/worksheets\/sheet\d+\.xml/)?.[0];
  if (!sheetFile) throw new Error("xlsx: no worksheet found");
  const ssXml = ssFile ? await ssFile.async("string") : "";
  const sheetXml = await sheetFile.async("string");
  const strings = ssXml ? parseSharedStrings(ssXml) : [];
  const rows = parseSheetRows(sheetXml, strings);

  const specs: ParsedBudgetSpecs = {
    jobName: null,
    jobNumber: null,
    version: null,
    weeks: null,
    prepEventDays: null,
    markets: null,
    eventDays: null,
    teams: null,
    hotel: null,
    ballroom: null,
    breakoutRooms: null,
    tents: null,
    clearSpanFrame: null,
    vehicles: null,
    staticDisplay: null,
    drive: null,
    competitors: null,
  };
  const lines: ParsedBudgetLine[] = [];
  const warnings: string[] = [];

  // 1) Header + spec rows live in 1..20.
  for (const row of rows) {
    if (row.rowNum > 30) break;
    const cells = row.cells;
    const cLabel = (cells.C || "").toLowerCase().trim();
    const dLabel = (cells.D || "").toLowerCase().trim();
    if (cLabel === "job name:") specs.jobName = strOrNull(cells.D);
    else if (cLabel === "job number:") specs.jobNumber = strOrNull(cells.D);
    else if (cLabel === "date:") specs.version = strOrNull(cells.D);
    if (dLabel && dLabel in SPEC_LABEL_TO_FIELD) {
      const field = SPEC_LABEL_TO_FIELD[dLabel];
      const v = numOrNull(cells.C);
      if (v !== null) specs[field] = v as never;
    }
  }

  // 2) Detail-line scan: a section opens when we see "Resp / Cost Code
  // / Line #" header in row.A=Resp / row.B=Cost Code; each subsequent
  // row whose B is a numeric code is a line until we hit "Total" in K.
  let currentCategory: string | null = null;
  let pendingCategory: string | null = null;
  for (const row of rows) {
    if (row.rowNum < 40) continue;
    const cells = row.cells;
    // Section header: column B has the human-readable category name and
    // column K is "Budgeted" (the template's marker), AND column A is empty.
    if (cells.B && !cells.A && cells.K && /budget/i.test(cells.K)) {
      pendingCategory = String(cells.B).trim();
      continue;
    }
    // Header row beneath: A=Resp B=Cost Code C=Line # ... — promote
    // pending category to current.
    if (
      pendingCategory &&
      cells.A &&
      /resp/i.test(String(cells.A)) &&
      cells.B &&
      /cost\s*code/i.test(String(cells.B))
    ) {
      currentCategory = pendingCategory;
      pendingCategory = null;
      continue;
    }
    // End-of-section marker: K=Total (no description / cost code).
    if (cells.K && /^total$/i.test(String(cells.K)) && !cells.B) {
      currentCategory = null;
      continue;
    }
    // Detail row inside an open section.
    if (currentCategory) {
      const code = numOrNull(cells.B);
      const lineNumber = strOrNull(cells.C);
      if (code === null && !lineNumber) continue;
      lines.push({
        category: currentCategory,
        costCode: code,
        responsible: strOrNull(cells.A),
        lineNumber: lineNumber,
        description: strOrNull(cells.D),
        name: strOrNull(cells.E),
        units: num(cells.J),
        rate: num(cells.K),
        total: num(cells.L),
      });
    }
  }

  if (lines.length === 0) {
    warnings.push("no detail lines parsed — file structure may differ");
  }

  return { specs, lines, warnings };
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

export interface ExportLineRow {
  categoryName: string;
  categoryKind: "fixed" | "variable";
  costCode: number | null;
  responsible: string | null;
  lineNumber: string | null;
  description: string | null;
  name: string | null;
  units: number;
  rate: number;
  total: number;
}

export interface ExportInput {
  jobName: string;
  jobNumber: string | null;
  version: string;
  specs: ParsedBudgetSpecs;
  fixedSubtotal: number;
  variableSubtotal: number;
  contingencyAmount: number;
  grandTotal: number;
  lines: ExportLineRow[];
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function colLetter(n: number): string {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

interface BuildCell {
  value: string | number | null;
  /** true = treat as inline string; default = number when typeof number. */
  inlineString?: boolean;
}

function cellXml(col: string, rowNum: number, c: BuildCell): string {
  if (c.value === null || c.value === undefined || c.value === "") return "";
  const ref = `${col}${rowNum}`;
  if (typeof c.value === "number" && !c.inlineString) {
    return `<c r="${ref}"><v>${c.value}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(String(c.value))}</t></is></c>`;
}

/**
 * Build a minimal valid xlsx mirroring the WPA template layout.
 * No styles, no formulas — we render pre-computed totals because the
 * canonical model already has them. Excel happily opens it.
 */
export async function buildBudgetXlsx(input: ExportInput): Promise<Uint8Array> {
  const sheetRows: string[] = [];

  const cell = (col: string, rowNum: number, c: BuildCell) =>
    cellXml(col, rowNum, c);

  const row = (rowNum: number, cells: string) =>
    `<row r="${rowNum}">${cells}</row>`;

  // Header block — row numbers chosen to approximate the WPA layout.
  sheetRows.push(
    row(
      1,
      cell("C", 1, { value: "Job Name:" }) +
        cell("D", 1, { value: input.jobName }),
    ),
  );
  sheetRows.push(
    row(
      2,
      cell("C", 2, { value: "Job Number:" }) +
        cell("D", 2, { value: input.jobNumber || "NA" }) +
        cell("E", 2, { value: "Version" }) +
        cell("F", 2, { value: input.version }),
    ),
  );

  const specPairs: Array<[number, string, number | null]> = [
    [4, "Weeks", input.specs.weeks],
    [5, "Prep/Event Days", input.specs.prepEventDays],
    [6, "Markets", input.specs.markets],
    [7, "Event Days", input.specs.eventDays],
    [8, "Teams", input.specs.teams],
    [11, "Hotel", input.specs.hotel],
    [12, "Ballroom", input.specs.ballroom],
    [13, "Breakout Rooms", input.specs.breakoutRooms],
    [14, "Tents", input.specs.tents],
    [15, "Clear-Span / Frame", input.specs.clearSpanFrame],
    [16, "Vehicles", input.specs.vehicles],
    [17, "Static Display", input.specs.staticDisplay],
    [18, "Drive", input.specs.drive],
    [19, "Competitors", input.specs.competitors],
  ];
  for (const [rn, label, val] of specPairs) {
    sheetRows.push(
      row(
        rn,
        cell("C", rn, { value: val ?? 0 }) + cell("D", rn, { value: label }),
      ),
    );
  }

  // Roll-up summary block (row 22 = fixed subtotal, 43 = variable, 44 = grand).
  sheetRows.push(
    row(
      22,
      cell("J", 22, { value: "FIXED COSTS" }) +
        cell("K", 22, { value: "Sub-Total" }) +
        cell("L", 22, { value: input.fixedSubtotal }),
    ),
  );
  sheetRows.push(
    row(
      43,
      cell("J", 43, { value: "VARIABLE COSTS" }) +
        cell("K", 43, { value: "Sub-Total" }) +
        cell("L", 43, { value: input.variableSubtotal }),
    ),
  );
  sheetRows.push(
    row(
      44,
      cell("K", 44, { value: "GRAND TOTAL" }) +
        cell("L", 44, { value: input.grandTotal }),
    ),
  );

  // Detail sections.
  let cursor = 46;
  const grouped = new Map<
    string,
    { kind: "fixed" | "variable"; items: ExportLineRow[] }
  >();
  for (const ln of input.lines) {
    const key = ln.categoryName;
    if (!grouped.has(key)) grouped.set(key, { kind: ln.categoryKind, items: [] });
    grouped.get(key)!.items.push(ln);
  }
  for (const [name, group] of grouped) {
    sheetRows.push(
      row(
        cursor,
        cell("B", cursor, { value: name }) +
          cell("K", cursor, { value: "Budgeted" }),
      ),
    );
    cursor++;
    sheetRows.push(
      row(
        cursor,
        cell("A", cursor, { value: "Resp" }) +
          cell("B", cursor, { value: "Cost Code" }) +
          cell("C", cursor, { value: "Line #" }) +
          cell("D", cursor, { value: "Description" }) +
          cell("E", cursor, { value: "Name" }) +
          cell("J", cursor, { value: "Units" }) +
          cell("K", cursor, { value: "Rate" }) +
          cell("L", cursor, { value: "Total" }),
      ),
    );
    cursor++;
    let subtotal = 0;
    for (const ln of group.items) {
      sheetRows.push(
        row(
          cursor,
          cell("A", cursor, { value: ln.responsible }) +
            cell("B", cursor, { value: ln.costCode ?? null }) +
            cell("C", cursor, { value: ln.lineNumber }) +
            cell("D", cursor, { value: ln.description }) +
            cell("E", cursor, { value: ln.name }) +
            cell("J", cursor, { value: ln.units }) +
            cell("K", cursor, { value: ln.rate }) +
            cell("L", cursor, { value: ln.total }),
        ),
      );
      subtotal += ln.total;
      cursor++;
    }
    sheetRows.push(
      row(
        cursor,
        cell("K", cursor, { value: "Total" }) +
          cell("L", cursor, { value: subtotal }),
      ),
    );
    cursor += 2;
  }

  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${sheetRows.join("")}</sheetData>` +
    `</worksheet>`;

  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets>` +
    `</workbook>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `</Relationships>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `</Types>`;

  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypes);
  zip.folder("_rels")!.file(".rels", rootRels);
  zip.folder("xl")!.file("workbook.xml", workbookXml);
  zip.folder("xl/_rels")!.file("workbook.xml.rels", workbookRels);
  zip.folder("xl/worksheets")!.file("sheet1.xml", sheetXml);
  return await zip.generateAsync({ type: "uint8array" });
}
