/**
 * Per-code dossier aggregation.
 *
 * Powers `/job-codes/[code]` — the cross-source view that turns a
 * single row in the SharePoint catalog into the full operational
 * picture of the code:
 *
 *   - Header: identity + the editable cells (Program / PO Number /
 *     PO Amount) as the cache last observed them. Editing stays on
 *     the index page so the dossier never bypasses the cell-writer
 *     safety gate.
 *   - Rollups: derived numbers (Spend YTD/MTD, PO Amount Remaining,
 *     receipt count, last activity). All computed on-demand from
 *     indexed lookups against `instinct_receipt_scans` +
 *     `instinct_job_codes_edits`. Deliberately NOT materialized —
 *     volume is low (<5k codes × <10 receipts/code) and freshness
 *     matters more than latency at this scale.
 *   - Receipts tab: applied receipt scans, ordered newest first.
 *   - Activity tab: combined audit-log edits + analytics events for
 *     the code, ordered newest first.
 *   - Mentions tab: deliberately deferred. The cross-source helper
 *     in `src/lib/search/` returns provider-specific result types,
 *     not a single "this code was mentioned here" stream — wiring
 *     it up cleanly is its own feature.
 *
 * Every read goes through `query`. No writes happen here; the page
 * is read-only (writes route through the existing /cell PATCH).
 */

import { query } from "@/lib/db";

export interface DossierHeader {
  code: string;
  description: string;
  active: boolean;
  category: string | null;
  program: string | null;
  poNumber: string | null;
  poAmount: string | null;
  /** Parsed numeric PO amount, or null when blank / unparseable. */
  poAmountNumeric: number | null;
  /** ISO timestamp from the cache for "last synced from SharePoint". */
  lastSeenAt: string;
  /** SharePoint webUrl for "Open source workbook" link. */
  webUrl: string | null;
}

export interface DossierRollups {
  /** Sum of receipt totals applied since the start of this calendar year. */
  spendYtd: number;
  /** Sum of receipt totals applied since the start of this calendar month. */
  spendMtd: number;
  /** All-time sum of receipt totals applied to this code. */
  spendAllTime: number;
  /** Number of distinct receipt scans applied to this code. */
  receiptCount: number;
  /** PO Amount minus sum of receipt totals; null when no PO Amount set.
   *  Negative means receipts have exceeded the PO — UI renders in red. */
  poRemaining: number | null;
  /** Most-recent activity timestamp across receipts + audit-log edits. */
  lastActivityAt: string | null;
}

export interface DossierReceipt {
  scanId: string;
  appliedAt: string;
  uploadedByEmail: string | null;
  merchant: string | null;
  transactionDate: string | null;
  total: number | null;
  currency: string | null;
  /** What the user actually committed (vs OCR-suggested). NULL fields
   *  mean the user chose not to apply that one. */
  appliedProgram: string | null;
  appliedPoNumber: string | null;
  appliedPoAmount: string | null;
}

export type DossierActivityKind = "cell_edit" | "event";

export interface DossierActivity {
  kind: DossierActivityKind;
  at: string;
  /** Display string assembled from the underlying row. */
  summary: string;
  /** Human-readable actor when known (email > id > "system"). */
  actor: string;
  /** Extra structured data for the UI (column changed, error, etc). */
  detail: Record<string, string | number | boolean | null>;
}

export interface CodeDossier {
  header: DossierHeader;
  rollups: DossierRollups;
  receipts: DossierReceipt[];
  activity: DossierActivity[];
}

/* Aliases mirror the parser + cell-writer — code can be stored under
   any of these header texts. Lowercased for comparisons. */
const CATEGORY_HEADERS_LOWER = new Set(["client/category", "client", "category"]);

function parsePoAmount(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  /* Strip everything except digits, dot, minus. Handles "$3,500.00",
     "USD 3500", "3,500.00 USD". Empty string → null. */
  const cleaned = String(raw).replace(/[^0-9.\-]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function pickCategory(extra: Record<string, string> | null): string | null {
  if (!extra) return null;
  for (const [k, v] of Object.entries(extra)) {
    if (CATEGORY_HEADERS_LOWER.has(k.toLowerCase()) && v?.trim()) {
      return v.trim();
    }
  }
  return null;
}

interface CacheRow {
  code: string;
  description: string | null;
  active: boolean;
  last_seen_at: string;
  source_web_url: string | null;
  extra: Record<string, string> | null;
  [k: string]: unknown;
}

interface ReceiptRow {
  id: string;
  applied_at: string;
  uploaded_by_email: string | null;
  fields: {
    merchantName?: string | null;
    transactionDate?: string | null;
    total?: number | null;
    currency?: string | null;
  };
  applied_program: string | null;
  applied_po_number: string | null;
  applied_po_amount: string | null;
  [k: string]: unknown;
}

interface EditRow {
  column_name: string;
  old_value: string | null;
  new_value: string;
  edited_by_email: string | null;
  edited_by: string;
  edited_by_role: string | null;
  status: "succeeded" | "failed";
  graph_error: string | null;
  created_at: string;
  [k: string]: unknown;
}

interface EventRow {
  event_type: string;
  user_id: string;
  user_role: string;
  metadata: Record<string, string | number | boolean | null>;
  timestamp: string;
  [k: string]: unknown;
}

/**
 * Build the full dossier for one code. Returns null when the code
 * isn't in the cache at all — caller should render a 404.
 *
 * Trade-off: this fans four queries (cache row, receipts, edits,
 * events). At our scale (low-thousands codes, hundreds of receipts
 * total) the per-page latency is well under 200ms with the existing
 * indexes. If/when the events table grows past ~10M rows, switch the
 * event query to a per-code materialized view; the metadata-LIKE
 * filter degrades on a sequential scan.
 */
export async function buildCodeDossier(
  code: string,
  workspaceId: string,
): Promise<CodeDossier | null> {
  const trimmed = code.trim();
  if (!trimmed) return null;
  // Tenant isolation: job codes (instinct_job_codes_cache) are an agency-global
  // catalogue with NO workspace_id column, but the receipts (instinct_receipt_scans)
  // and edits (instinct_job_codes_edits) applied to a code are workspace-owned
  // (workspace_id NOT NULL). Two workspaces can share a global code, so every
  // tenant-owned source below MUST be filtered by workspace_id - otherwise
  // workspace A's dossier rolls up workspace B's spend and audit trail. See
  // docs/tenant-isolation.md + the repo-wide guardrail.

  const cacheRes = await query<CacheRow>(
    `SELECT code, description, active, last_seen_at, source_web_url, extra
     FROM instinct_job_codes_cache
     WHERE LOWER(code) = LOWER($1)
     LIMIT 1`,
    [trimmed],
  );
  const cacheRow = cacheRes.rows[0];
  if (!cacheRow) return null;

  const extra = (cacheRow.extra ?? {}) as Record<string, string>;
  const program = extra["Program"] ?? null;
  const poNumber = extra["PO Number"] ?? null;
  const poAmount = extra["PO Amount"] ?? null;
  const poAmountNumeric = parsePoAmount(poAmount);

  const header: DossierHeader = {
    code: cacheRow.code,
    description: cacheRow.description ?? "",
    active: !!cacheRow.active,
    category: pickCategory(extra),
    program: program?.trim() || null,
    poNumber: poNumber?.trim() || null,
    poAmount: poAmount?.trim() || null,
    poAmountNumeric,
    lastSeenAt: cacheRow.last_seen_at,
    webUrl: cacheRow.source_web_url,
  };

  /* Receipts applied to this code, newest first. We match on
     applied_to_code case-insensitively — receipts were saved with
     whatever case the user picked from the dropdown, which should
     match the cache row but defending against drift is cheap. */
  const receiptsRes = await query<ReceiptRow>(
    `SELECT id, applied_at, uploaded_by_email, fields,
            applied_program, applied_po_number, applied_po_amount
     FROM instinct_receipt_scans
     WHERE LOWER(applied_to_code) = LOWER($1)
       AND workspace_id = $2
       AND applied_at IS NOT NULL
     ORDER BY applied_at DESC
     LIMIT 200`,
    [trimmed, workspaceId],
  );
  const receipts: DossierReceipt[] = receiptsRes.rows.map((r) => ({
    scanId: r.id,
    appliedAt: r.applied_at,
    uploadedByEmail: r.uploaded_by_email,
    merchant: r.fields?.merchantName ?? null,
    transactionDate: r.fields?.transactionDate ?? null,
    total: typeof r.fields?.total === "number" ? r.fields.total : null,
    currency: r.fields?.currency ?? null,
    appliedProgram: r.applied_program,
    appliedPoNumber: r.applied_po_number,
    appliedPoAmount: r.applied_po_amount,
  }));

  /* Spend rollups: prefer the OCR-extracted `fields.total` (it's the
     receipt amount as scanned). When OCR didn't return a number, fall
     back to parsing `applied_po_amount` so a manually-entered total
     still counts toward Spend. */
  const now = new Date();
  const ytdStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const mtdStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  let spendYtd = 0;
  let spendMtd = 0;
  let spendAllTime = 0;
  for (const r of receipts) {
    const amount = r.total ?? parsePoAmount(r.appliedPoAmount) ?? 0;
    const at = new Date(r.appliedAt);
    spendAllTime += amount;
    if (at >= ytdStart) spendYtd += amount;
    if (at >= mtdStart) spendMtd += amount;
  }

  /* Audit-log edits for the code, newest first. Joined on code_lower
     (the migration's indexed column). */
  const editsRes = await query<EditRow>(
    `SELECT column_name, old_value, new_value, edited_by, edited_by_email,
            edited_by_role, status, graph_error, created_at
     FROM instinct_job_codes_edits
     WHERE code_lower = LOWER($1)
       AND workspace_id = $2
     ORDER BY created_at DESC
     LIMIT 200`,
    [trimmed, workspaceId],
  );

  /* Analytics events that carry this code in metadata. JSONB ->> is
     index-able via the existing GIN(metadata) — fast enough at our
     scale; will need re-engineering if events ever crosses ~10M rows. */
  const eventsRes = await query<EventRow>(
    `SELECT event_type, user_id, user_role, metadata, timestamp
     FROM instinct_events
     WHERE event_type LIKE 'jobcodes.%'
       AND LOWER(metadata->>'code') = LOWER($1)
     ORDER BY timestamp DESC
     LIMIT 200`,
    [trimmed],
  );

  const activity: DossierActivity[] = [];
  for (const e of editsRes.rows) {
    const summary = e.status === "succeeded"
      ? `${e.column_name} → "${e.new_value}"`
      : `${e.column_name} attempted → "${e.new_value}" (failed)`;
    activity.push({
      kind: "cell_edit",
      at: e.created_at,
      summary,
      actor: e.edited_by_email ?? e.edited_by ?? "unknown",
      detail: {
        column: e.column_name,
        old_value: e.old_value,
        new_value: e.new_value,
        status: e.status,
        graph_error: e.graph_error,
        role: e.edited_by_role,
      },
    });
  }
  for (const ev of eventsRes.rows) {
    /* Cell-edit events duplicate audit rows — drop the duplicates so
       the timeline isn't doubled. */
    if (ev.event_type === "jobcodes.cell_edit_succeeded" || ev.event_type === "jobcodes.cell_edit_failed") {
      continue;
    }
    activity.push({
      kind: "event",
      at: ev.timestamp,
      summary: ev.event_type.replace(/^jobcodes\./, ""),
      actor: typeof ev.metadata?.edited_by_email === "string"
        ? ev.metadata.edited_by_email
        : ev.user_id,
      detail: ev.metadata ?? {},
    });
  }
  activity.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  const lastActivityAt = activity[0]?.at
    ?? receipts[0]?.appliedAt
    ?? null;

  const rollups: DossierRollups = {
    spendYtd,
    spendMtd,
    spendAllTime,
    receiptCount: receipts.length,
    poRemaining: poAmountNumeric != null ? poAmountNumeric - spendAllTime : null,
    lastActivityAt,
  };

  return { header, rollups, receipts, activity };
}
