/**
 * brief-versions — unified version-history aggregator for site briefs.
 *
 * The designer surface for "show me every change to this brief, let me
 * compare, and let me roll back." We do NOT own a new table — every
 * version event is already persisted by existing flows:
 *
 *   - apex_site_brief_generations (031) — every AI/PDF/image extraction
 *     that ultimately landed on this site
 *   - apex_site_brief_edits      (029) — every prompt-editor RFC-6902
 *     patch applied on top of the current brief
 *
 * We UNION both tables at the SQL layer (single round-trip, ordered
 * DESC) and project them into a homogeneous `BriefVersionEntry` so the
 * UI can render one timeline regardless of source.
 *
 * Restore path is the only WRITE: it updates apex_site_projects.brief
 * (the canonical current state) AND inserts an audit row into
 * apex_site_brief_edits with kind="restore" so the timeline captures
 * the rollback itself. Everything goes through `writeQuery` with
 * expectRows: 1 — silent-discard on restore is the worst possible
 * failure mode here, so we defend against it loudly.
 *
 * Closed-loop: `diffBriefs` returns a structured change list. The
 * restore emit fires `site.version_restored` with field_changes so
 * the learning loop can flag brittle edit patterns (clients whose
 * designers roll back often = signal that AI brief extraction or
 * prompt edits need tuning for that client).
 */

import { randomUUID, createHash } from "node:crypto";
import { safeQuery, writeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import type { SiteBrief } from "@/lib/sites-schema";

/* ------------------------------ Types --------------------------------- */

export type BriefVersionKind =
  | "initial"
  | "ai_extraction"
  | "prompt_edit"
  | "manual_save"
  | "restore";

export interface BriefVersionEntry {
  /** Unique per entry. Prefixed `gen_` / `edit_` so callers can trace back. */
  id: string;
  kind: BriefVersionKind;
  siteId: string;
  /** The brief as-of this point. For prompt_edit this is the AFTER state. */
  brief: SiteBrief;
  authorId: string | null;
  authorRole: string | null;
  /** Plain-English summary of the change ("AI extracted from image/png…"). */
  summary: string;
  /** ISO-8601 UTC. */
  createdAt: string;
  /**
   * Chain pointer. For "restore" rows this is the ID of the version
   * being restored FROM (the target). Otherwise null.
   */
  parentVersionId: string | null;
}

export interface DiffEntry {
  path: string;
  op: "add" | "remove" | "replace";
  before?: unknown;
  after?: unknown;
}

/* ------------------------------ SQL ----------------------------------- */

/**
 * Single UNION query — each source table projects into the same column
 * set so the ORDER BY at the top level can sort the merged stream. Cast
 * rejection_reason to NULL and accepted to NULL on the generations side
 * since those concepts don't apply there.
 *
 * IMPORTANT: the prompt_edit branch filters `accepted IS NOT FALSE` —
 * we don't show patches the designer actively rejected, and we also
 * don't show guardrail-blocked attempts (accepted=false, rejection
 * reason set). Un-decided rows (accepted=NULL) ARE shown because the
 * patch was APPLIED; the decision is just pending.
 */
const LIST_VERSIONS_SQL = `
  SELECT
    'gen_' || gen.id       AS id,
    CASE
      WHEN gen.rejection_reason = 'restore' THEN 'restore'
      ELSE 'ai_extraction'
    END                    AS kind,
    gen.project_id         AS site_id,
    gen.extracted_brief    AS brief,
    gen.requested_by       AS author_id,
    NULL::text             AS author_role,
    gen.source_mime        AS detail_mime,
    gen.source_size        AS detail_size,
    gen.model              AS detail_model,
    NULL::text             AS detail_instruction,
    gen.created_at         AS created_at,
    NULL::text             AS parent_version_id
  FROM apex_site_brief_generations gen
  WHERE gen.project_id = $1 AND gen.accepted IS NOT FALSE

  UNION ALL

  SELECT
    'edit_' || e.id        AS id,
    CASE
      WHEN e.rejection_reason = 'restore' THEN 'restore'
      WHEN e.instruction LIKE 'RESTORE:%' THEN 'restore'
      ELSE 'prompt_edit'
    END                    AS kind,
    e.project_id           AS site_id,
    p.brief                AS brief,
    e.user_id              AS author_id,
    e.user_role            AS author_role,
    NULL::text             AS detail_mime,
    NULL::int              AS detail_size,
    e.model                AS detail_model,
    e.instruction          AS detail_instruction,
    e.created_at           AS created_at,
    e.brief_before_hash    AS parent_version_id
  FROM apex_site_brief_edits e
  JOIN apex_site_projects p ON p.id = e.project_id
  WHERE e.project_id = $1
    AND (e.accepted IS NULL OR e.accepted = TRUE)

  ORDER BY created_at DESC
  LIMIT $2
`;

interface RawVersionRow {
  id: string;
  kind: BriefVersionKind;
  site_id: string;
  brief: SiteBrief | string;
  author_id: string | null;
  author_role: string | null;
  detail_mime: string | null;
  detail_size: number | null;
  detail_model: string | null;
  detail_instruction: string | null;
  created_at: string;
  parent_version_id: string | null;
}

function bytesLabel(n: number | null): string {
  if (!n || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function summariseRow(r: RawVersionRow): string {
  if (r.kind === "ai_extraction") {
    const mime = r.detail_mime ?? "image";
    const size = bytesLabel(r.detail_size);
    return `AI extracted from ${mime} (${size})`;
  }
  if (r.kind === "restore") {
    return "Restored an earlier version";
  }
  // prompt_edit
  const instr = (r.detail_instruction ?? "").trim();
  if (!instr) return "Prompt edit applied";
  const trimmed = instr.length > 80 ? `${instr.slice(0, 77)}…` : instr;
  return `Edited: "${trimmed}"`;
}

function normaliseBrief(raw: SiteBrief | string | null | undefined): SiteBrief {
  if (!raw) return { client: "", product: { name: "" }, pages: [] };
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as SiteBrief;
    } catch {
      return { client: "", product: { name: "" }, pages: [] };
    }
  }
  return raw;
}

function toEntry(row: RawVersionRow): BriefVersionEntry {
  return {
    id: row.id,
    kind: row.kind,
    siteId: row.site_id,
    brief: normaliseBrief(row.brief),
    authorId: row.author_id,
    authorRole: row.author_role,
    summary: summariseRow(row),
    createdAt:
      typeof row.created_at === "string"
        ? row.created_at
        : new Date(row.created_at as unknown as number).toISOString(),
    parentVersionId: row.parent_version_id,
  };
}

/* ------------------------- Public API --------------------------------- */

export interface ListVersionsOpts {
  /** Default 50 — enough for any reasonable designer session. */
  limit?: number;
}

/**
 * Unified timeline for a site. Newest first. UNIONs both source tables
 * in a single query so one DB round-trip serves the panel.
 */
export async function listVersionsForSite(
  siteId: string,
  opts: ListVersionsOpts = {},
): Promise<BriefVersionEntry[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const result = await safeQuery<RawVersionRow>(LIST_VERSIONS_SQL, [
    siteId,
    limit,
  ]);
  return result.rows.map(toEntry);
}

/**
 * Find a single version by its synthesised id (`gen_…` / `edit_…`).
 * Returns null if missing — used by the restore path to validate input
 * before writing.
 */
export async function findVersionById(
  siteId: string,
  versionId: string,
): Promise<BriefVersionEntry | null> {
  const list = await listVersionsForSite(siteId, { limit: 200 });
  return list.find((v) => v.id === versionId) ?? null;
}

/* -------------------------- Diff -------------------------------------- */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep structural diff over SiteBrief-shaped values. Pure — no I/O.
 * Recurses into arrays by index and objects by key so sections / theme
 * / pages all surface as discrete paths. Identical inputs yield an
 * empty array.
 *
 * Paths use RFC 6902 JSON-pointer syntax so they are directly
 * translatable to the patches that `brief-edit` emits.
 */
export function diffBriefs(a: SiteBrief, b: SiteBrief): DiffEntry[] {
  const entries: DiffEntry[] = [];
  walk(a as unknown, b as unknown, "", entries);
  return entries;
}

function walk(
  a: unknown,
  b: unknown,
  path: string,
  out: DiffEntry[],
): void {
  // Identical by reference or deep-equal primitive — nothing to record.
  if (a === b) return;
  const aMissing = a === undefined;
  const bMissing = b === undefined;
  if (aMissing && !bMissing) {
    out.push({ path, op: "add", after: b });
    return;
  }
  if (!aMissing && bMissing) {
    out.push({ path, op: "remove", before: a });
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
      walk(a[i], b[i], `${path}/${i}`, out);
    }
    return;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      walk(a[k], b[k], `${path}/${escapeJsonPointer(k)}`, out);
    }
    return;
  }
  // Leaf mismatch (primitive vs primitive, or shape change).
  if (!deepEqual(a, b)) {
    out.push({ path, op: "replace", before: a, after: b });
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

function escapeJsonPointer(seg: string): string {
  return seg.replace(/~/g, "~0").replace(/\//g, "~1");
}

/* -------------------------- Restore ---------------------------------- */

export interface RestoreVersionInput {
  siteId: string;
  toVersionId: string;
  userId: string;
  userRole: string;
}

export class RestoreVersionError extends Error {
  constructor(
    message: string,
    public reason: "version_not_found" | "site_not_found" | "write_failed",
  ) {
    super(message);
    this.name = "RestoreVersionError";
  }
}

function hashBrief(brief: unknown): string {
  return createHash("sha256").update(JSON.stringify(brief)).digest("hex");
}

/**
 * Roll the site's current brief back to a previous version. Both writes
 * (the brief update AND the audit row in apex_site_brief_edits) use
 * `writeQuery` with expectRows: 1 so any silent-discard surfaces as
 * WriteQueryError — never as a 200 with stale state.
 *
 * Emits `site.version_restored` with the field-change count so the
 * learning loop can detect brittle edit patterns (clients whose
 * designers roll back often = signal that extraction tuning is needed).
 *
 * Returns the NEW current BriefVersionEntry so the UI can splice it
 * into the top of the timeline without a round-trip refetch.
 */
export async function restoreVersion(
  input: RestoreVersionInput,
): Promise<BriefVersionEntry> {
  const target = await findVersionById(input.siteId, input.toVersionId);
  if (!target) {
    throw new RestoreVersionError(
      `version ${input.toVersionId} not found on site ${input.siteId}`,
      "version_not_found",
    );
  }

  // Read current brief (SELECT — safeQuery is fine) so we can diff for
  // the analytics signal + supply the before-hash for the audit row.
  const current = await safeQuery<{ brief: SiteBrief | string }>(
    `SELECT brief FROM apex_site_projects WHERE id = $1`,
    [input.siteId],
  );
  if (current.rows.length === 0) {
    throw new RestoreVersionError(
      `site ${input.siteId} not found`,
      "site_not_found",
    );
  }
  const currentBrief = normaliseBrief(current.rows[0].brief);
  const restoredBrief = target.brief;

  const fieldChanges = diffBriefs(currentBrief, restoredBrief).length;
  const beforeHash = hashBrief(currentBrief);
  const afterHash = hashBrief(restoredBrief);

  // WRITE 1: update the canonical current state. expectRows: 1 ensures
  // we don't silently "succeed" against an RLS policy or auto-updatable
  // view that dropped the write.
  await writeQuery(
    `UPDATE apex_site_projects
        SET brief = $2,
            display_name = $3,
            updated_at = NOW()
      WHERE id = $1
    RETURNING id`,
    [
      input.siteId,
      JSON.stringify(restoredBrief),
      restoredBrief.product?.name ?? "Restored site",
    ],
    { expectRows: 1 },
  );

  // WRITE 2: audit row so the timeline itself shows the restore event.
  // We shape it to be a valid apex_site_brief_edits row; kind="restore"
  // is encoded in rejection_reason so the UNION query above can flip
  // `kind` without needing a new column.
  const auditId = `brief_edit_${randomUUID()}`;
  await writeQuery(
    `INSERT INTO apex_site_brief_edits
       (id, project_id, user_id, user_role, instruction, patch,
        brief_before_hash, brief_after_hash, accepted, rejection_reason,
        latency_ms, tokens_in, tokens_out, cost_usd, model,
        created_at, decided_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,TRUE,'restore',
             0, 0, 0, 0, 'restore',
             NOW(), NOW())
  RETURNING id`,
    [
      auditId,
      input.siteId,
      input.userId,
      input.userRole,
      `RESTORE: rolled back to ${input.toVersionId}`,
      JSON.stringify([
        { op: "replace", path: "", value: "__restore_marker__" },
      ]),
      beforeHash,
      afterHash,
    ],
    { expectRows: 1 },
  );

  trackEvent("site.version_restored", input.userId, input.userRole, {
    site_id: input.siteId,
    from_version_id: input.toVersionId,
    to_version_id: `edit_${auditId}`,
    field_changes: fieldChanges,
  });

  return {
    id: `edit_${auditId}`,
    kind: "restore",
    siteId: input.siteId,
    brief: restoredBrief,
    authorId: input.userId,
    authorRole: input.userRole,
    summary: `Restored an earlier version (${fieldChanges} field change${fieldChanges === 1 ? "" : "s"})`,
    createdAt: new Date().toISOString(),
    parentVersionId: input.toVersionId,
  };
}
