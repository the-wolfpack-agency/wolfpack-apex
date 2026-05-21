/**
 * Cell-level writer for the Job Codes SharePoint workbook.
 *
 * Strict policy enforced in code (do NOT relax without CTO approval —
 * the rule is in feedback memory):
 *   - Column allowlist: D, E, F ONLY. B and C (Client/Category, Job
 *     Code) and any other column are HARD-REFUSED before any Graph
 *     call. Even passing column="C" returns { ok: false,
 *     code: "forbidden_column" } — no fetch goes out.
 *   - Single-cell PATCH only. No range writes, no row inserts/deletes,
 *     no worksheet creates. The Graph call is exactly one
 *     `worksheets/{name}/range(address='X5')/PATCH { values: [[v]] }`.
 *   - Row identity is resolved at write time by re-pulling the
 *     workbook's usedRange and matching on the Job Code column. We
 *     don't trust a cached rowIndex because the sheet can change
 *     between refreshes. If the code isn't found, we abort — never
 *     guess a row.
 *
 * Returns a typed Result so callers (the API route) can distinguish
 * permission/validation refusals from Graph errors and log accordingly.
 */

import { acquireSharePointToken } from "./sharepoint-source";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/**
 * Editable column HEADERS — finance owns these. The writer discovers
 * the actual column LETTER for each header at write time by scanning
 * the worksheet's header row. This decouples the writer from a
 * specific workbook layout — if finance ever inserts a column or
 * renames the sheet, the writer keeps working as long as these
 * header texts still exist.
 */
export const EDITABLE_HEADERS = ["Program", "PO Number", "PO Amount"] as const;
export type EditableHeader = (typeof EDITABLE_HEADERS)[number];

/* Header texts considered to identify the Job Code column. Same
   tolerance set as the parser in sharepoint-source.ts. */
const JOB_CODE_HEADER_ALIASES = new Set(["code", "jobcode", "job code", "job_code"]);

/* Headers we will NEVER write to, regardless of position. The job
   code identifier and the client/category column are immutable from
   Instinct per CTO directive 2026-05-21. */
const FORBIDDEN_HEADER_LOWER = new Set(["client/category", "client", "category", ...JOB_CODE_HEADER_ALIASES]);

/* Backward-compat shim: the old API contract spoke in column letters
   D/E/F. Callers still doing that get mapped to the canonical header
   names before discovery. */
export const LETTER_TO_HEADER: Readonly<Record<string, EditableHeader>> = {
  D: "Program", E: "PO Number", F: "PO Amount",
};

/** 0-based column letter, for `${LETTER}${rowIndex}` cell addressing. */
function indexToLetter(idx: number): string {
  if (idx < 0 || idx > 25) return "";
  return String.fromCharCode("A".charCodeAt(0) + idx);
}

export type CellEditError =
  | "forbidden_column"     // not in EDITABLE_COLUMNS — never fires Graph
  | "code_not_found"       // Job Code doesn't match any row
  | "not_configured"       // no Graph token
  | "graph_forbidden"      // Graph said 403
  | "graph_unavailable"    // network / 5xx / non-2xx
  | "invalid_input";       // bad value shape

export interface CellEditOk {
  ok: true;
  rowIndex: number;       // 1-based Excel row that was written
  cellAddress: string;    // e.g. "D7"
  previousValue: string;  // what was in the cell before the PATCH
  newValue: string;       // confirmed echo of what we wrote
  tokenKind: "delegated" | "app_only";
}
export interface CellEditFail {
  ok: false;
  code: CellEditError;
  detail: string;
}
export type CellEditResult = CellEditOk | CellEditFail;

export interface CellEditInput {
  /** Instinct user id whose delegated token should be tried first.
   *  Falls back to the app-only token if none. */
  triggeredBy: string | null;
  /** Required cache pointers — caller resolves these via repo. */
  driveId: string;
  itemId: string;
  sheetName: string;
  /** The Job Code identifier. Looked up case-insensitively against
   *  the workbook's Job Code column (discovered by header). */
  jobCode: string;
  /** The HEADER NAME of the column to PATCH — MUST be in
   *  EDITABLE_HEADERS. Accepts the deprecated column-letter form
   *  via LETTER_TO_HEADER for callers that haven't migrated. */
  columnName?: EditableHeader;
  /** Deprecated alias. Pass `columnName` instead. */
  column?: string;
  /** The new value. */
  value: string;
}

interface UsedRangeResponse {
  values?: Array<Array<string | number | boolean | null>>;
}

interface RangeResponse {
  values?: Array<Array<string | number | boolean | null>>;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 400);
  } catch {
    return "<no-body>";
  }
}

async function graphGet<T>(
  path: string,
  token: string,
): Promise<{ ok: true; value: T } | { ok: false; status: number; detail: string }> {
  let res: Response;
  try {
    res = await fetch(`${GRAPH_BASE}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
  } catch (err) {
    return { ok: false, status: 0, detail: (err as Error).message };
  }
  if (!res.ok) return { ok: false, status: res.status, detail: await safeText(res) };
  return { ok: true, value: (await res.json()) as T };
}

async function graphPatch<T>(
  path: string,
  token: string,
  body: unknown,
): Promise<{ ok: true; value: T } | { ok: false; status: number; detail: string }> {
  let res: Response;
  try {
    res = await fetch(`${GRAPH_BASE}/${path}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, status: 0, detail: (err as Error).message };
  }
  if (!res.ok) return { ok: false, status: res.status, detail: await safeText(res) };
  return { ok: true, value: (await res.json()) as T };
}

/**
 * Patch one cell. Hard-allowlists the column BEFORE any Graph call so
 * a malicious or buggy caller cannot rewrite columns B/C even with a
 * valid token.
 */
export async function patchJobCodeCell(
  input: CellEditInput,
): Promise<CellEditResult> {
  // ── Resolve target header name (accept letter alias for back-compat) ──
  let columnName: EditableHeader | null = null;
  if (input.columnName && (EDITABLE_HEADERS as readonly string[]).includes(input.columnName)) {
    columnName = input.columnName;
  } else if (input.column) {
    const mapped = LETTER_TO_HEADER[String(input.column).toUpperCase()];
    if (mapped) columnName = mapped;
  }
  if (!columnName) {
    return {
      ok: false,
      code: "forbidden_column",
      detail: `column must be one of EDITABLE_HEADERS (${EDITABLE_HEADERS.join(", ")}) or letter ${Object.keys(LETTER_TO_HEADER).join("/")}`,
    };
  }
  if (typeof input.value !== "string") {
    return { ok: false, code: "invalid_input", detail: "value must be a string" };
  }
  if (!input.jobCode || !input.jobCode.trim()) {
    return { ok: false, code: "invalid_input", detail: "jobCode required" };
  }
  if (!input.driveId || !input.itemId || !input.sheetName) {
    return { ok: false, code: "invalid_input", detail: "driveId/itemId/sheetName required" };
  }

  const acquired = await acquireSharePointToken(input.triggeredBy);
  if (!acquired) {
    return {
      ok: false,
      code: "not_configured",
      detail: "no Graph token (delegated lookup failed and app-only unconfigured)",
    };
  }

  // ── 1. Pull usedRange to discover headers + locate the row ──
  const usedRes = await graphGet<UsedRangeResponse>(
    `drives/${encodeURIComponent(input.driveId)}/items/${encodeURIComponent(input.itemId)}/workbook/worksheets/${encodeURIComponent(input.sheetName)}/usedRange(valuesOnly=true)?$select=values`,
    acquired.token,
  );
  if (!usedRes.ok) {
    return {
      ok: false,
      code: usedRes.status === 403 ? "graph_forbidden" : "graph_unavailable",
      detail: `usedRange HTTP ${usedRes.status} ${usedRes.detail}`,
    };
  }
  const values = usedRes.value.values ?? [];
  if (values.length === 0) {
    return { ok: false, code: "code_not_found", detail: `sheet "${input.sheetName}" is empty` };
  }

  /* Discover column indices from the header row by NAME (decouples
     us from any specific letter layout finance uses). */
  const headerRaw = (values[0] ?? []).map((v) => String(v ?? "").trim());
  const headerLower = headerRaw.map((h) => h.toLowerCase());
  const jobCol = headerLower.findIndex((h) => JOB_CODE_HEADER_ALIASES.has(h));
  if (jobCol < 0) {
    return {
      ok: false,
      code: "code_not_found",
      detail: `sheet "${input.sheetName}" has no Job Code column (tried headers: ${Array.from(JOB_CODE_HEADER_ALIASES).join(", ")})`,
    };
  }
  const editCol = headerRaw.findIndex((h) => h === columnName);
  if (editCol < 0) {
    return {
      ok: false,
      code: "code_not_found",
      detail: `sheet "${input.sheetName}" has no column with header "${columnName}"`,
    };
  }
  /* Final guard: even if a header named "Code" / "Client/Category"
     ever crept into EDITABLE_HEADERS, refuse to write a column whose
     header lower-cases into the forbidden set. */
  if (FORBIDDEN_HEADER_LOWER.has(headerLower[editCol])) {
    return {
      ok: false,
      code: "forbidden_column",
      detail: `header "${headerRaw[editCol]}" is immutable from Instinct`,
    };
  }

  const target = input.jobCode.trim().toLowerCase();
  let rowIndex = -1;
  let previousValue = "";
  for (let i = 1; i < values.length; i++) {
    const row = values[i] ?? [];
    const cellCode = String(row[jobCol] ?? "").trim().toLowerCase();
    if (cellCode === target) {
      rowIndex = i + 1;
      previousValue = String(row[editCol] ?? "");
      break;
    }
  }
  if (rowIndex < 0) {
    return {
      ok: false,
      code: "code_not_found",
      detail: `no row in sheet "${input.sheetName}" has Job Code = "${input.jobCode}" (matched against column ${indexToLetter(jobCol)} which holds header "${headerRaw[jobCol]}")`,
    };
  }

  // ── 2. PATCH the single cell ──
  const cellAddress = `${indexToLetter(editCol)}${rowIndex}`;
  const patchRes = await graphPatch<RangeResponse>(
    `drives/${encodeURIComponent(input.driveId)}/items/${encodeURIComponent(input.itemId)}/workbook/worksheets/${encodeURIComponent(input.sheetName)}/range(address='${cellAddress}')`,
    acquired.token,
    { values: [[input.value]] },
  );
  if (!patchRes.ok) {
    return {
      ok: false,
      code: patchRes.status === 403 ? "graph_forbidden" : "graph_unavailable",
      detail: `PATCH ${cellAddress} HTTP ${patchRes.status} ${patchRes.detail}`,
    };
  }
  /* Echo what Graph confirmed — defensive against type coercion
     surprises (Excel may round, format, or reject the value). */
  const echoed = patchRes.value.values?.[0]?.[0];
  const newValue = echoed === undefined || echoed === null ? input.value : String(echoed);

  return {
    ok: true,
    rowIndex,
    cellAddress,
    previousValue,
    newValue,
    tokenKind: acquired.kind,
  };
}
