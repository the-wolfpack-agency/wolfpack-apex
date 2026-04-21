/**
 * Company-wide goals — v1 OKR / KR CRUD.
 *
 * Design (see migration 079 header for full rationale):
 *   - ONE shared set of company OKRs per quarter. No cascading, no
 *     team-level OKRs.
 *   - Every teammate contributes visibly against the SAME KR rows via
 *     goals-contributions.ts.
 *
 * This module owns OKR + KR lifecycle ONLY. The unified contribution
 * stream (manual + auto-linked MS events / tasks) lives in
 * `goals-contributions.ts`; the north-star sparkline lives in
 * `goals-north-star.ts`. Callers that just want "the active OKRs with
 * their KRs" only need this file.
 *
 * Backing schema: migration 079.
 *   instinct_company_okrs(id, quarter, objective, status, created_at,
 *                         created_by_user_id)
 *   instinct_company_krs(id, okr_id, metric, target_value, current_value,
 *                        unit, cadence, display_order, created_at)
 *
 * writeQuery is used for every write so silent-discard becomes an
 * explicit WriteQueryError (see feedback_no_silent_data_loss.md +
 * src/lib/db.ts:writeQuery docstring).
 */

import { safeQuery, writeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

export type OKRStatus = "draft" | "active" | "archived";
export type KRCadence = "daily" | "weekly" | "monthly" | "quarterly";

export interface KRInput {
  metric: string;
  target: number;
  unit?: string | null;
  cadence?: KRCadence;
}

export interface CompanyKR {
  id: string;
  okr_id: string;
  metric: string;
  target_value: number;
  current_value: number;
  unit: string | null;
  cadence: KRCadence;
  display_order: number;
  created_at: string;
}

export interface CompanyOKR {
  id: string;
  quarter: string;
  objective: string;
  status: OKRStatus;
  created_at: string;
  created_by_user_id: string | null;
  // Nested under `krs` per task spec. The dashboard can iterate
  // okr.krs directly; there is NO `key_results` alias — the stub used
  // that name but no downstream code references it yet.
  krs: CompanyKR[];
}

// Convenience aliases for callers that prefer `OKR`/`KR`.
export type OKR = CompanyOKR;
export type KR = CompanyKR;

export interface CreateOKRInput {
  quarter: string;
  objective: string;
  krs: KRInput[];
  status?: OKRStatus;
  created_by_user_id?: string | null;
}

// ---------------------------------------------------------------------
// Row-shape hydration. pg returns `numeric` as string; coerce at the
// boundary so callers get numbers not strings.
// ---------------------------------------------------------------------

interface OKRRow {
  id: string;
  quarter: string;
  objective: string;
  status: OKRStatus;
  created_at: string | Date;
  created_by_user_id: string | null;
}

interface KRRow {
  id: string;
  okr_id: string;
  metric: string;
  target_value: string | number;
  current_value: string | number;
  unit: string | null;
  cadence: KRCadence;
  display_order: number;
  created_at: string | Date;
}

function toNumber(v: string | number): number {
  return typeof v === "number" ? v : Number(v);
}

function toIso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function hydrateOKR(row: OKRRow, krs: CompanyKR[]): CompanyOKR {
  return {
    id: row.id,
    quarter: row.quarter,
    objective: row.objective,
    status: row.status,
    created_at: toIso(row.created_at),
    created_by_user_id: row.created_by_user_id,
    krs,
  };
}

function hydrateKR(row: KRRow): CompanyKR {
  return {
    id: row.id,
    okr_id: row.okr_id,
    metric: row.metric,
    target_value: toNumber(row.target_value),
    current_value: toNumber(row.current_value),
    unit: row.unit,
    cadence: row.cadence,
    display_order: row.display_order,
    created_at: toIso(row.created_at),
  };
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/**
 * Active OKRs with KRs eager-loaded in display_order. One round-trip
 * per table — we intentionally do NOT json_agg in SQL because the
 * payload is tiny (≤ ~4 OKRs × ~5 KRs) and the flat shape keeps types
 * honest.
 *
 * Returns [] when no OKRs are active OR in shadow mode (no
 * DATABASE_URL). The dashboard renders an explicit empty state
 * upstream; never a blank page.
 */
export async function getActiveOKRs(
  opts: { quarter?: string } = {},
): Promise<CompanyOKR[]> {
  const { rows: okrRows } = opts.quarter
    ? await safeQuery<OKRRow>(
        `SELECT id, quarter, objective, status, created_at, created_by_user_id
           FROM instinct_company_okrs
          WHERE status = 'active' AND quarter = $1
          ORDER BY created_at ASC`,
        [opts.quarter],
      )
    : await safeQuery<OKRRow>(
        `SELECT id, quarter, objective, status, created_at, created_by_user_id
           FROM instinct_company_okrs
          WHERE status = 'active'
          ORDER BY quarter DESC, created_at ASC`,
      );

  if (okrRows.length === 0) return [];

  const okrIds = okrRows.map((o) => o.id);
  const { rows: krRows } = await safeQuery<KRRow>(
    `SELECT id, okr_id, metric, target_value, current_value, unit,
            cadence, display_order, created_at
       FROM instinct_company_krs
      WHERE okr_id = ANY($1::uuid[])
      ORDER BY display_order ASC, created_at ASC`,
    [okrIds],
  );

  const krsByOkr = new Map<string, CompanyKR[]>();
  for (const row of krRows) {
    const kr = hydrateKR(row);
    const list = krsByOkr.get(kr.okr_id) ?? [];
    list.push(kr);
    krsByOkr.set(kr.okr_id, list);
  }

  return okrRows.map((r) => hydrateOKR(r, krsByOkr.get(r.id) ?? []));
}

/**
 * Create an OKR plus its child KRs.
 *
 * The insert is NOT client-side transactional — the connection pool
 * auto-commits each writeQuery call. If a KR insert fails mid-way
 * the parent OKR remains but is partially populated; callers should
 * surface the WriteQueryError to the UI and either retry the failed
 * KR or archive the partial OKR. The dashboard's create flow is a
 * single round-trip (whole OKR-with-KRs) so this race is unlikely in
 * practice; documented trade-off.
 *
 * Fires `goal.okr_created` after the parent insert succeeds.
 */
export async function createOKR(input: CreateOKRInput): Promise<CompanyOKR> {
  const { quarter, objective, krs, status = "active" } = input;
  if (!quarter) throw new Error("createOKR: quarter is required");
  if (!objective) throw new Error("createOKR: objective is required");

  const { rows: okrOut } = await writeQuery<OKRRow>(
    `INSERT INTO instinct_company_okrs
       (quarter, objective, status, created_by_user_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, quarter, objective, status, created_at, created_by_user_id`,
    [quarter, objective, status, input.created_by_user_id ?? null],
    { expectRows: 1 },
  );
  const parent = okrOut[0];

  const krOut: CompanyKR[] = [];
  for (let i = 0; i < krs.length; i++) {
    const k = krs[i];
    const { rows } = await writeQuery<KRRow>(
      `INSERT INTO instinct_company_krs
         (okr_id, metric, target_value, current_value, unit, cadence, display_order)
       VALUES ($1, $2, $3, 0, $4, $5, $6)
       RETURNING id, okr_id, metric, target_value, current_value, unit,
                 cadence, display_order, created_at`,
      [
        parent.id,
        k.metric,
        k.target,
        k.unit ?? null,
        k.cadence ?? "quarterly",
        i,
      ],
      { expectRows: 1 },
    );
    krOut.push(hydrateKR(rows[0]));
  }

  trackEvent(
    "goal.okr_created",
    input.created_by_user_id ?? "system",
    "unknown",
    { quarter },
  );

  return hydrateOKR(parent, krOut);
}

/**
 * Append a new KR to an existing OKR. Any authenticated teammate may
 * call this (not just admins) — it's the "supplement the company OKR"
 * path. The new KR lands at display_order = (max + 1) so the OKR card
 * preserves its original order.
 *
 * Fires `goal.kr_added` so the learning loop can see who supplemented
 * which OKR.
 */
export async function addKRToOKR(
  okr_id: string,
  input: KRInput,
  userId: string,
): Promise<CompanyKR | null> {
  if (!okr_id) throw new Error("addKRToOKR: okr_id is required");
  if (!input.metric) throw new Error("addKRToOKR: metric is required");
  if (typeof input.target !== "number" || !Number.isFinite(input.target)) {
    throw new Error("addKRToOKR: target must be a finite number");
  }

  // Confirm the OKR exists (and isn't archived) before appending.
  const { rows: okrRows } = await safeQuery<{ id: string; status: OKRStatus }>(
    `SELECT id, status FROM instinct_company_okrs WHERE id = $1`,
    [okr_id],
  );
  if (okrRows.length === 0) return null;
  if (okrRows[0].status === "archived") return null;

  const { rows: maxRows } = await safeQuery<{ max_order: number | null }>(
    `SELECT MAX(display_order) AS max_order
     FROM instinct_company_krs WHERE okr_id = $1`,
    [okr_id],
  );
  const nextOrder = (maxRows[0]?.max_order ?? -1) + 1;

  const { rows } = await writeQuery<KRRow>(
    `INSERT INTO instinct_company_krs
       (okr_id, metric, target_value, current_value, unit, cadence, display_order)
     VALUES ($1, $2, $3, 0, $4, $5, $6)
     RETURNING id, okr_id, metric, target_value, current_value, unit,
               cadence, display_order, created_at`,
    [
      okr_id,
      input.metric,
      input.target,
      input.unit ?? null,
      input.cadence ?? "quarterly",
      nextOrder,
    ],
    { expectRows: 1 },
  );
  const kr = hydrateKR(rows[0]);

  trackEvent("goal.kr_added", userId, "unknown", {
    okr_id,
    kr_id: kr.id,
    cadence: kr.cadence,
  });

  return kr;
}

/**
 * Update a KR's current_value. Fires `goal.kr_updated` with the
 * signed delta (new - old) so the learning loop sees KR velocity.
 * Returns the fresh KR row, or null when the id doesn't exist.
 *
 * No-op updates (value unchanged) still fire the event with delta = 0
 * — the learning loop cares that "someone refreshed but nothing
 * moved" as distinct from "no refresh at all."
 */
export async function updateKRCurrent(
  kr_id: string,
  value: number,
  userId: string = "system",
): Promise<CompanyKR | null> {
  if (!Number.isFinite(value)) {
    throw new Error("updateKRCurrent: value must be a finite number");
  }

  const { rows: before } = await safeQuery<{ current_value: string | number }>(
    `SELECT current_value FROM instinct_company_krs WHERE id = $1`,
    [kr_id],
  );
  if (before.length === 0) return null;
  const prev = toNumber(before[0].current_value);

  const { rows } = await writeQuery<KRRow>(
    `UPDATE instinct_company_krs
        SET current_value = $2
      WHERE id = $1
      RETURNING id, okr_id, metric, target_value, current_value, unit,
                cadence, display_order, created_at`,
    [kr_id, value],
    { expectRows: 1 },
  );
  const kr = hydrateKR(rows[0]);

  trackEvent("goal.kr_updated", userId, "unknown", {
    kr_id,
    delta: kr.current_value - prev,
  });

  return kr;
}

/**
 * Archive an OKR (soft retire). Contributions + KRs remain intact —
 * only the lifecycle flag flips. No analytics event: archival is a
 * mechanical follow-up, not a behavioral signal.
 *
 * Returns the hydrated archived OKR (including its KR list) on
 * success, or null when the id doesn't exist.
 */
/**
 * Admin-only edit of an OKR's top-line fields (objective + quarter).
 * KR edits go through addKRToOKR / updateKRCurrent. Returns the
 * hydrated OKR or null when the id is missing.
 */
export interface UpdateOKRInput {
  objective?: string;
  quarter?: string;
}
export async function updateOKR(
  okr_id: string,
  input: UpdateOKRInput,
  userId: string,
): Promise<CompanyOKR | null> {
  const { rows: peek } = await safeQuery<{ id: string }>(
    `SELECT id FROM instinct_company_okrs WHERE id = $1`,
    [okr_id],
  );
  if (peek.length === 0) return null;

  const sets: string[] = [];
  const params: unknown[] = [okr_id];
  if (typeof input.objective === "string" && input.objective.trim().length > 0) {
    params.push(input.objective.trim());
    sets.push(`objective = $${params.length}`);
  }
  if (typeof input.quarter === "string" && /^\d{4}-Q[1-4]$/.test(input.quarter)) {
    params.push(input.quarter);
    sets.push(`quarter = $${params.length}`);
  }
  if (sets.length === 0) {
    // Nothing to change — return current shape.
    const current = await getActiveOKRs();
    return current.find((o) => o.id === okr_id) ?? null;
  }

  const { rows } = await writeQuery<OKRRow>(
    `UPDATE instinct_company_okrs SET ${sets.join(", ")}
      WHERE id = $1
      RETURNING id, quarter, objective, status, created_at, created_by_user_id`,
    params,
    { expectRows: 1 },
  );
  const { rows: krRows } = await safeQuery<KRRow>(
    `SELECT id, okr_id, metric, target_value, current_value, unit,
            cadence, display_order, created_at
       FROM instinct_company_krs
      WHERE okr_id = $1
      ORDER BY display_order ASC, created_at ASC`,
    [okr_id],
  );
  trackEvent("goal.okr_edited", userId, "unknown", { okr_id });
  return hydrateOKR(rows[0], krRows.map(hydrateKR));
}

export async function archiveOKR(okr_id: string): Promise<CompanyOKR | null> {
  // Peek first — if the row is missing, writeQuery with expectRows:1
  // would throw; safeQuery gives us a clean null return instead.
  const { rows: peek } = await safeQuery<{ id: string }>(
    `SELECT id FROM instinct_company_okrs WHERE id = $1`,
    [okr_id],
  );
  if (peek.length === 0) return null;

  const { rows } = await writeQuery<OKRRow>(
    `UPDATE instinct_company_okrs
        SET status = 'archived'
      WHERE id = $1
      RETURNING id, quarter, objective, status, created_at, created_by_user_id`,
    [okr_id],
    { expectRows: 1 },
  );

  const { rows: krRows } = await safeQuery<KRRow>(
    `SELECT id, okr_id, metric, target_value, current_value, unit,
            cadence, display_order, created_at
       FROM instinct_company_krs
      WHERE okr_id = $1
      ORDER BY display_order ASC, created_at ASC`,
    [okr_id],
  );

  return hydrateOKR(rows[0], krRows.map(hydrateKR));
}
