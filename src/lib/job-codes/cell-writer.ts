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

/** Excel column letters we permit Instinct to PATCH. */
export const EDITABLE_COLUMNS = ["D", "E", "F"] as const;
export type EditableColumn = (typeof EDITABLE_COLUMNS)[number];

/** The Job Code identifier lives in column C. The writer uses this to
 *  locate the row that matches the caller's `code` argument. If
 *  finance moves it, this MUST be updated AND the editable list
 *  re-validated against the new positions. */
export const JOB_CODE_COLUMN = "C" as const;

/** Excel column letter → 0-based index. Capital ASCII only. */
function columnToIndex(letter: string): number {
  if (!/^[A-Z]$/.test(letter)) return -1;
  return letter.charCodeAt(0) - "A".charCodeAt(0);
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
  /** The Job Code identifier (matches column C). Case-insensitive. */
  jobCode: string;
  /** The Excel column letter to PATCH. MUST be in EDITABLE_COLUMNS. */
  column: string;
  /** The new value. Cast to string for SharePoint; Excel does its own
   *  type coercion on number-shaped strings ("123" → number). */
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
  // ── Defense in depth: validate column first, no Graph call yet ──
  const colUpper = String(input.column ?? "").toUpperCase();
  if (!(EDITABLE_COLUMNS as readonly string[]).includes(colUpper)) {
    return {
      ok: false,
      code: "forbidden_column",
      detail: `column "${input.column}" is not in EDITABLE_COLUMNS (${EDITABLE_COLUMNS.join(", ")})`,
    };
  }
  if (colUpper === JOB_CODE_COLUMN) {
    /* Belt-and-suspenders: if someone ever appends "C" to
       EDITABLE_COLUMNS, this still refuses because column C is the
       Job Code identifier and must never be mutated. */
    return {
      ok: false,
      code: "forbidden_column",
      detail: "column C holds the Job Code identifier and is immutable",
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

  // ── 1. Pull usedRange to locate the row matching jobCode ──
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
  const jobCol = columnToIndex(JOB_CODE_COLUMN);
  const target = input.jobCode.trim().toLowerCase();
  /* Row 1 is the header → start at i=1. The Excel row index for the
     matching record is (i + 1) because Excel rows are 1-based AND the
     header lives on row 1. */
  let rowIndex = -1;
  let previousValue = "";
  const editCol = columnToIndex(colUpper);
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
      detail: `no row in sheet "${input.sheetName}" has Job Code = "${input.jobCode}"`,
    };
  }

  // ── 2. PATCH the single cell ──
  const cellAddress = `${colUpper}${rowIndex}`;
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
