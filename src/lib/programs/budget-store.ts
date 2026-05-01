/**
 * Program-budget store — Postgres CRUD for the cost-budget tables.
 *
 * Design contract:
 *   - All reads use safeQuery (shadow-mode safe). All writes use
 *     pool/writeQuery and require DATABASE_URL.
 *   - The roll-up is computed in SQL — Postgres aggregates much faster
 *     than JS and the result feeds both the dashboard summary and the
 *     xlsx exporter without a second pass.
 *   - line.total is a generated column (units * rate) so the JS layer
 *     never has to keep it in sync. Insert/update only sets units +
 *     rate; total comes back on the SELECT.
 *
 * Analytics: every mutation emits a typed event from the API layer
 * (`programBudget.created`, etc.) — keep this file pure DB so the
 * sync hook + xlsx importer can call it without re-emitting events.
 */

import { pool, safeQuery, writeQuery, WriteQueryError } from "@/lib/db";

export type CategoryKind = "fixed" | "variable";

export interface BudgetCategoryRecord {
  id: string;
  code: number;
  name: string;
  kind: CategoryKind;
  sortOrder: number;
}

export interface BudgetRecord {
  id: string;
  name: string;
  jobNumber: string | null;
  version: string;
  status: "draft" | "active" | "closed" | "archived";
  clientId: string | null;
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
  contingencyPct: number;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BudgetLineRecord {
  id: string;
  budgetId: string;
  categoryId: string;
  costCode: number | null;
  responsibleUserId: string | null;
  lineNumber: string | null;
  description: string | null;
  name: string | null;
  units: number;
  rate: number;
  total: number;
  notes: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface BudgetActualRecord {
  id: string;
  lineId: string;
  source: "manual" | "qb_bill" | "qb_invoice" | "expense" | "receipt";
  sourceId: string | null;
  vendor: string | null;
  amount: number;
  currency: string;
  occurredAt: string;
  evidence: Record<string, unknown>;
  createdAt: string;
}

interface BudgetRow {
  id: string;
  name: string;
  job_number: string | null;
  version: string;
  status: BudgetRecord["status"];
  client_id: string | null;
  weeks: string | null;
  prep_event_days: string | null;
  markets: number | null;
  event_days: string | null;
  teams: number | null;
  hotel: number | null;
  ballroom: number | null;
  breakout_rooms: number | null;
  tents: number | null;
  clear_span_frame: number | null;
  vehicles: number | null;
  static_display: number | null;
  drive: number | null;
  competitors: number | null;
  contingency_pct: string;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface CategoryRow {
  id: string;
  code: number;
  name: string;
  kind: CategoryKind;
  sort_order: number;
}

interface LineRow {
  id: string;
  budget_id: string;
  category_id: string;
  cost_code: string | null;
  responsible_user_id: string | null;
  line_number: string | null;
  description: string | null;
  name: string | null;
  units: string;
  rate: string;
  total: string;
  notes: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface ActualRow {
  id: string;
  line_id: string;
  source: BudgetActualRecord["source"];
  source_id: string | null;
  vendor: string | null;
  amount: string;
  currency: string;
  occurred_at: string;
  evidence_jsonb: Record<string, unknown>;
  created_at: string;
}

const BUDGET_COLS =
  "id, name, job_number, version, status, client_id, weeks, prep_event_days, " +
  "markets, event_days, teams, hotel, ballroom, breakout_rooms, tents, " +
  "clear_span_frame, vehicles, static_display, drive, competitors, " +
  "contingency_pct, notes, created_by, created_at, updated_at";

const LINE_COLS =
  "id, budget_id, category_id, cost_code, responsible_user_id, line_number, " +
  "description, name, units, rate, total, notes, sort_order, " +
  "created_at, updated_at";

const ACTUAL_COLS =
  "id, line_id, source, source_id, vendor, amount, currency, occurred_at, " +
  "evidence_jsonb, created_at";

function n(v: string | null): number | null {
  if (v === null || v === undefined) return null;
  const num = Number(v);
  return Number.isFinite(num) ? num : null;
}

function rowToBudget(r: BudgetRow): BudgetRecord {
  return {
    id: r.id,
    name: r.name,
    jobNumber: r.job_number,
    version: r.version,
    status: r.status,
    clientId: r.client_id,
    weeks: n(r.weeks),
    prepEventDays: n(r.prep_event_days),
    markets: r.markets,
    eventDays: n(r.event_days),
    teams: r.teams,
    hotel: r.hotel,
    ballroom: r.ballroom,
    breakoutRooms: r.breakout_rooms,
    tents: r.tents,
    clearSpanFrame: r.clear_span_frame,
    vehicles: r.vehicles,
    staticDisplay: r.static_display,
    drive: r.drive,
    competitors: r.competitors,
    contingencyPct: Number(r.contingency_pct),
    notes: r.notes,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToLine(r: LineRow): BudgetLineRecord {
  return {
    id: r.id,
    budgetId: r.budget_id,
    categoryId: r.category_id,
    costCode: n(r.cost_code),
    responsibleUserId: r.responsible_user_id,
    lineNumber: r.line_number,
    description: r.description,
    name: r.name,
    units: Number(r.units),
    rate: Number(r.rate),
    total: Number(r.total),
    notes: r.notes,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToCategory(r: CategoryRow): BudgetCategoryRecord {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    kind: r.kind,
    sortOrder: r.sort_order,
  };
}

function rowToActual(r: ActualRow): BudgetActualRecord {
  return {
    id: r.id,
    lineId: r.line_id,
    source: r.source,
    sourceId: r.source_id,
    vendor: r.vendor,
    amount: Number(r.amount),
    currency: r.currency,
    occurredAt: r.occurred_at,
    evidence: r.evidence_jsonb || {},
    createdAt: r.created_at,
  };
}

/* ------------------------------------------------------------------ */
/* Categories (seeded; mostly read-only)                               */
/* ------------------------------------------------------------------ */

export async function listBudgetCategories(): Promise<BudgetCategoryRecord[]> {
  const result = await safeQuery<CategoryRow>(
    `SELECT id, code, name, kind, sort_order
       FROM instinct_program_budget_categories
      WHERE active = TRUE
      ORDER BY sort_order ASC, name ASC`,
    [],
  );
  return result.rows.map(rowToCategory);
}

export async function getCategoryByCode(
  code: number,
): Promise<BudgetCategoryRecord | null> {
  const result = await safeQuery<CategoryRow>(
    `SELECT id, code, name, kind, sort_order
       FROM instinct_program_budget_categories
      WHERE code = $1 LIMIT 1`,
    [code],
  );
  return result.rows[0] ? rowToCategory(result.rows[0]) : null;
}

export async function getCategoryByName(
  name: string,
): Promise<BudgetCategoryRecord | null> {
  if (!name) return null;
  const result = await safeQuery<CategoryRow>(
    `SELECT id, code, name, kind, sort_order
       FROM instinct_program_budget_categories
      WHERE LOWER(name) = LOWER($1) LIMIT 1`,
    [name.trim()],
  );
  return result.rows[0] ? rowToCategory(result.rows[0]) : null;
}

/* ------------------------------------------------------------------ */
/* Budgets                                                             */
/* ------------------------------------------------------------------ */

export interface CreateBudgetInput {
  name: string;
  jobNumber?: string | null;
  version?: string;
  clientId?: string | null;
  specs?: Partial<
    Pick<
      BudgetRecord,
      | "weeks"
      | "prepEventDays"
      | "markets"
      | "eventDays"
      | "teams"
      | "hotel"
      | "ballroom"
      | "breakoutRooms"
      | "tents"
      | "clearSpanFrame"
      | "vehicles"
      | "staticDisplay"
      | "drive"
      | "competitors"
    >
  >;
  contingencyPct?: number;
  notes?: string | null;
  createdBy?: string | null;
}

export async function createBudget(
  input: CreateBudgetInput,
): Promise<BudgetRecord> {
  if (!process.env.DATABASE_URL) {
    throw new WriteQueryError("createBudget requires DATABASE_URL", "no_database");
  }
  const name = input.name.trim();
  if (!name) throw new Error("name required");
  const s = input.specs || {};
  const result = await writeQuery<BudgetRow>(
    `INSERT INTO instinct_program_budgets
       (name, job_number, version, client_id, weeks, prep_event_days,
        markets, event_days, teams, hotel, ballroom, breakout_rooms,
        tents, clear_span_frame, vehicles, static_display, drive,
        competitors, contingency_pct, notes, created_by)
     VALUES
       ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
        $18,$19,$20,$21)
     RETURNING ${BUDGET_COLS}`,
    [
      name,
      input.jobNumber ?? null,
      input.version ?? "v1",
      input.clientId ?? null,
      s.weeks ?? null,
      s.prepEventDays ?? null,
      s.markets ?? null,
      s.eventDays ?? null,
      s.teams ?? null,
      s.hotel ?? null,
      s.ballroom ?? null,
      s.breakoutRooms ?? null,
      s.tents ?? null,
      s.clearSpanFrame ?? null,
      s.vehicles ?? null,
      s.staticDisplay ?? null,
      s.drive ?? null,
      s.competitors ?? null,
      input.contingencyPct ?? 0,
      input.notes ?? null,
      input.createdBy ?? null,
    ],
  );
  return rowToBudget(result.rows[0]);
}

export async function listBudgets(
  opts: { status?: BudgetRecord["status"]; limit?: number } = {},
): Promise<BudgetRecord[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const params: unknown[] = [];
  let where = "TRUE";
  if (opts.status) {
    params.push(opts.status);
    where = `status = $${params.length}`;
  }
  params.push(limit);
  const result = await safeQuery<BudgetRow>(
    `SELECT ${BUDGET_COLS}
       FROM instinct_program_budgets
      WHERE ${where}
      ORDER BY updated_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(rowToBudget);
}

export async function getBudget(id: string): Promise<BudgetRecord | null> {
  if (!id) return null;
  const result = await safeQuery<BudgetRow>(
    `SELECT ${BUDGET_COLS} FROM instinct_program_budgets WHERE id = $1 LIMIT 1`,
    [id],
  );
  return result.rows[0] ? rowToBudget(result.rows[0]) : null;
}

export async function updateBudget(
  id: string,
  patch: Partial<CreateBudgetInput> & { status?: BudgetRecord["status"] },
): Promise<BudgetRecord> {
  if (!process.env.DATABASE_URL) {
    throw new WriteQueryError("updateBudget requires DATABASE_URL", "no_database");
  }
  if (!id) throw new Error("id required");
  const sets: string[] = [];
  const params: unknown[] = [];
  function add(col: string, val: unknown) {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  }
  if (patch.name !== undefined) {
    const v = patch.name.trim();
    if (!v) throw new Error("name cannot be empty");
    add("name", v);
  }
  if (patch.jobNumber !== undefined) add("job_number", patch.jobNumber);
  if (patch.version !== undefined) add("version", patch.version);
  if (patch.clientId !== undefined) add("client_id", patch.clientId);
  if (patch.contingencyPct !== undefined) add("contingency_pct", patch.contingencyPct);
  if (patch.notes !== undefined) add("notes", patch.notes);
  if (patch.status !== undefined) add("status", patch.status);
  const s = patch.specs || {};
  const specMap: Array<[string, keyof NonNullable<typeof patch.specs>]> = [
    ["weeks", "weeks"],
    ["prep_event_days", "prepEventDays"],
    ["markets", "markets"],
    ["event_days", "eventDays"],
    ["teams", "teams"],
    ["hotel", "hotel"],
    ["ballroom", "ballroom"],
    ["breakout_rooms", "breakoutRooms"],
    ["tents", "tents"],
    ["clear_span_frame", "clearSpanFrame"],
    ["vehicles", "vehicles"],
    ["static_display", "staticDisplay"],
    ["drive", "drive"],
    ["competitors", "competitors"],
  ];
  for (const [col, key] of specMap) {
    const v = s[key];
    if (v !== undefined) add(col, v);
  }
  if (sets.length === 0) {
    const cur = await getBudget(id);
    if (!cur) throw new Error("budget not found");
    return cur;
  }
  sets.push("updated_at = NOW()");
  params.push(id);
  const result = await writeQuery<BudgetRow>(
    `UPDATE instinct_program_budgets
        SET ${sets.join(", ")}
      WHERE id = $${params.length}
      RETURNING ${BUDGET_COLS}`,
    params,
  );
  if (result.rows.length === 0) throw new Error("budget not found");
  return rowToBudget(result.rows[0]);
}

export async function deleteBudget(id: string): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new WriteQueryError("deleteBudget requires DATABASE_URL", "no_database");
  }
  await writeQuery(
    `DELETE FROM instinct_program_budgets WHERE id = $1`,
    [id],
  );
}

/* ------------------------------------------------------------------ */
/* Lines                                                               */
/* ------------------------------------------------------------------ */

export interface CreateLineInput {
  budgetId: string;
  categoryId: string;
  costCode?: number | null;
  responsibleUserId?: string | null;
  lineNumber?: string | null;
  description?: string | null;
  name?: string | null;
  units?: number;
  rate?: number;
  notes?: string | null;
  sortOrder?: number;
}

export async function createLine(
  input: CreateLineInput,
): Promise<BudgetLineRecord> {
  if (!process.env.DATABASE_URL) {
    throw new WriteQueryError("createLine requires DATABASE_URL", "no_database");
  }
  if (!input.budgetId) throw new Error("budgetId required");
  if (!input.categoryId) throw new Error("categoryId required");
  const result = await writeQuery<LineRow>(
    `INSERT INTO instinct_program_budget_lines
       (budget_id, category_id, cost_code, responsible_user_id, line_number,
        description, name, units, rate, notes, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING ${LINE_COLS}`,
    [
      input.budgetId,
      input.categoryId,
      input.costCode ?? null,
      input.responsibleUserId ?? null,
      input.lineNumber ?? null,
      input.description ?? null,
      input.name ?? null,
      input.units ?? 0,
      input.rate ?? 0,
      input.notes ?? null,
      input.sortOrder ?? 0,
    ],
  );
  return rowToLine(result.rows[0]);
}

export async function listLines(
  budgetId: string,
): Promise<BudgetLineRecord[]> {
  if (!budgetId) return [];
  const result = await safeQuery<LineRow>(
    `SELECT ${LINE_COLS}
       FROM instinct_program_budget_lines
      WHERE budget_id = $1
      ORDER BY sort_order ASC, created_at ASC`,
    [budgetId],
  );
  return result.rows.map(rowToLine);
}

export async function updateLine(
  id: string,
  patch: Partial<Omit<CreateLineInput, "budgetId">>,
): Promise<BudgetLineRecord> {
  if (!process.env.DATABASE_URL) {
    throw new WriteQueryError("updateLine requires DATABASE_URL", "no_database");
  }
  if (!id) throw new Error("id required");
  const sets: string[] = [];
  const params: unknown[] = [];
  function add(col: string, val: unknown) {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  }
  if (patch.categoryId !== undefined) add("category_id", patch.categoryId);
  if (patch.costCode !== undefined) add("cost_code", patch.costCode);
  if (patch.responsibleUserId !== undefined)
    add("responsible_user_id", patch.responsibleUserId);
  if (patch.lineNumber !== undefined) add("line_number", patch.lineNumber);
  if (patch.description !== undefined) add("description", patch.description);
  if (patch.name !== undefined) add("name", patch.name);
  if (patch.units !== undefined) add("units", patch.units);
  if (patch.rate !== undefined) add("rate", patch.rate);
  if (patch.notes !== undefined) add("notes", patch.notes);
  if (patch.sortOrder !== undefined) add("sort_order", patch.sortOrder);
  if (sets.length === 0) {
    const r = await safeQuery<LineRow>(
      `SELECT ${LINE_COLS} FROM instinct_program_budget_lines WHERE id = $1`,
      [id],
    );
    if (r.rows.length === 0) throw new Error("line not found");
    return rowToLine(r.rows[0]);
  }
  sets.push("updated_at = NOW()");
  params.push(id);
  const result = await writeQuery<LineRow>(
    `UPDATE instinct_program_budget_lines
        SET ${sets.join(", ")}
      WHERE id = $${params.length}
      RETURNING ${LINE_COLS}`,
    params,
  );
  if (result.rows.length === 0) throw new Error("line not found");
  return rowToLine(result.rows[0]);
}

export async function deleteLine(id: string): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new WriteQueryError("deleteLine requires DATABASE_URL", "no_database");
  }
  await writeQuery(
    `DELETE FROM instinct_program_budget_lines WHERE id = $1`,
    [id],
  );
}

/* ------------------------------------------------------------------ */
/* Bulk insert (used by xlsx importer — single transaction)            */
/* ------------------------------------------------------------------ */

export async function bulkCreateLines(
  rows: CreateLineInput[],
): Promise<number> {
  if (rows.length === 0) return 0;
  if (!process.env.DATABASE_URL) {
    throw new WriteQueryError(
      "bulkCreateLines requires DATABASE_URL",
      "no_database",
    );
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let n = 0;
    for (const r of rows) {
      await client.query(
        `INSERT INTO instinct_program_budget_lines
           (budget_id, category_id, cost_code, responsible_user_id,
            line_number, description, name, units, rate, notes, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          r.budgetId,
          r.categoryId,
          r.costCode ?? null,
          r.responsibleUserId ?? null,
          r.lineNumber ?? null,
          r.description ?? null,
          r.name ?? null,
          r.units ?? 0,
          r.rate ?? 0,
          r.notes ?? null,
          r.sortOrder ?? 0,
        ],
      );
      n++;
    }
    await client.query("COMMIT");
    return n;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ */
/* Actuals                                                             */
/* ------------------------------------------------------------------ */

export interface CreateActualInput {
  lineId: string;
  source: BudgetActualRecord["source"];
  sourceId?: string | null;
  vendor?: string | null;
  amount: number;
  currency?: string;
  occurredAt?: string;
  evidence?: Record<string, unknown>;
}

export async function createActual(
  input: CreateActualInput,
): Promise<BudgetActualRecord> {
  if (!process.env.DATABASE_URL) {
    throw new WriteQueryError("createActual requires DATABASE_URL", "no_database");
  }
  if (!input.lineId) throw new Error("lineId required");
  if (!Number.isFinite(input.amount)) throw new Error("amount required");
  const result = await writeQuery<ActualRow>(
    `INSERT INTO instinct_program_budget_actuals
       (line_id, source, source_id, vendor, amount, currency, occurred_at, evidence_jsonb)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, NOW()), $8::jsonb)
     RETURNING ${ACTUAL_COLS}`,
    [
      input.lineId,
      input.source,
      input.sourceId ?? null,
      input.vendor ?? null,
      input.amount,
      input.currency ?? "USD",
      input.occurredAt ?? null,
      JSON.stringify(input.evidence || {}),
    ],
  );
  return rowToActual(result.rows[0]);
}

export async function listActuals(
  budgetId: string,
): Promise<BudgetActualRecord[]> {
  if (!budgetId) return [];
  const result = await safeQuery<ActualRow>(
    `SELECT a.${ACTUAL_COLS.split(", ").join(", a.")}
       FROM instinct_program_budget_actuals a
       JOIN instinct_program_budget_lines l ON l.id = a.line_id
      WHERE l.budget_id = $1
      ORDER BY a.occurred_at DESC`,
    [budgetId],
  );
  return result.rows.map(rowToActual);
}

/* ------------------------------------------------------------------ */
/* Roll-up (the dashboard summary + xlsx export feed)                  */
/* ------------------------------------------------------------------ */

export interface CategoryRollup {
  categoryId: string;
  code: number;
  name: string;
  kind: CategoryKind;
  sortOrder: number;
  lineCount: number;
  plannedTotal: number;
  actualTotal: number;
  variance: number;
  variancePct: number | null;
}

export interface BudgetRollup {
  fixed: CategoryRollup[];
  variable: CategoryRollup[];
  fixedSubtotal: number;
  variableSubtotal: number;
  plannedGrandTotal: number;
  actualGrandTotal: number;
  variance: number;
  contingencyAmount: number;
  contingencyPct: number;
}

interface RollupRow {
  category_id: string;
  code: number;
  name: string;
  kind: CategoryKind;
  sort_order: number;
  line_count: string;
  planned_total: string;
  actual_total: string;
}

/**
 * Roll-up query — groups every category with a left-join to lines and
 * a left-join to actuals so categories with no lines still appear (zero
 * planned, zero actual). One round-trip; renders the full summary.
 */
export async function getBudgetRollup(
  budgetId: string,
): Promise<BudgetRollup> {
  const budget = await getBudget(budgetId);
  if (!budget) {
    return {
      fixed: [],
      variable: [],
      fixedSubtotal: 0,
      variableSubtotal: 0,
      plannedGrandTotal: 0,
      actualGrandTotal: 0,
      variance: 0,
      contingencyAmount: 0,
      contingencyPct: 0,
    };
  }
  const result = await safeQuery<RollupRow>(
    `SELECT c.id          AS category_id,
            c.code        AS code,
            c.name        AS name,
            c.kind        AS kind,
            c.sort_order  AS sort_order,
            COUNT(l.id)::text                                 AS line_count,
            COALESCE(SUM(l.total), 0)::text                   AS planned_total,
            COALESCE((
              SELECT SUM(a.amount)
                FROM instinct_program_budget_actuals a
                JOIN instinct_program_budget_lines l2 ON l2.id = a.line_id
               WHERE l2.budget_id = $1
                 AND l2.category_id = c.id
            ), 0)::text                                       AS actual_total
       FROM instinct_program_budget_categories c
  LEFT JOIN instinct_program_budget_lines l
         ON l.category_id = c.id AND l.budget_id = $1
      WHERE c.active = TRUE
      GROUP BY c.id, c.code, c.name, c.kind, c.sort_order
      ORDER BY c.sort_order ASC, c.name ASC`,
    [budgetId],
  );

  const fixed: CategoryRollup[] = [];
  const variable: CategoryRollup[] = [];
  let fixedSubtotal = 0;
  let variableSubtotal = 0;
  let actualGrand = 0;

  for (const r of result.rows) {
    const planned = Number(r.planned_total);
    const actual = Number(r.actual_total);
    const variance = actual - planned;
    const variancePct = planned > 0 ? (variance / planned) * 100 : null;
    const item: CategoryRollup = {
      categoryId: r.category_id,
      code: r.code,
      name: r.name,
      kind: r.kind,
      sortOrder: r.sort_order,
      lineCount: Number(r.line_count),
      plannedTotal: planned,
      actualTotal: actual,
      variance,
      variancePct,
    };
    if (r.kind === "fixed") {
      fixed.push(item);
      fixedSubtotal += planned;
    } else {
      variable.push(item);
      variableSubtotal += planned;
    }
    actualGrand += actual;
  }
  const plannedGrand = fixedSubtotal + variableSubtotal;
  const contingencyAmount = (plannedGrand * budget.contingencyPct) / 100;

  return {
    fixed,
    variable,
    fixedSubtotal,
    variableSubtotal,
    plannedGrandTotal: plannedGrand + contingencyAmount,
    actualGrandTotal: actualGrand,
    variance: actualGrand - (plannedGrand + contingencyAmount),
    contingencyAmount,
    contingencyPct: budget.contingencyPct,
  };
}
