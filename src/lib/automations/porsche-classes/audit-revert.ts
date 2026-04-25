/**
 * porsche-classes / audit-revert — handlers that actually UNDO the three
 * automated action kinds. Pair with `audit-repo.ts` (which only marks the
 * audit row reverted_at/reverted_by); the route layer orchestrates:
 *
 *   1. load row (audit-repo.getActionById)
 *   2. 24h window + already-reverted checks
 *   3. dispatch to ONE of the handlers below
 *   4. on { ok: true } → audit-repo.revertAction(...)
 *
 * Contract:
 *   - Every handler accepts the AuditActionRecord narrowed to its kind
 *     and returns a structured `{ ok: true } | { ok: false, error }`.
 *   - Handlers NEVER throw. A pg outage, a missing row, or a Graph 500
 *     all surface as `{ ok: false }`. The route returns the result + a
 *     500 status when ok is false (except for soft-fail cases below).
 *   - Handlers are IDEMPOTENT. Re-running an already-applied revert is a
 *     no-op (DELETE ... WHERE id = $1 returning 0 rows is fine).
 *
 * Soft-fail rules:
 *   - SharePoint DELETE on 404 is treated as success — the file is
 *     already gone, the desired state is achieved.
 *   - Override DELETE on 0 rows is treated as success — the override is
 *     already gone (e.g. another admin reverted it manually).
 *   - Snapshot DELETE on 0 rows is treated as success for the same reason.
 *
 * The "restore the original parse_failure exception" piece for survey
 * splits is BEST-EFFORT: if `original_error` and `exception_id` are
 * captured in the audit detail, we re-open the original exception (or
 * insert a fresh one) so the artifact still surfaces in the queue
 * post-undo. If neither is present (audit row pre-dates the capture),
 * we still succeed but log a warning — re-quarantining is preferred to
 * silently losing the artifact.
 */

import { query, writeQuery, WriteQueryError } from "@/lib/db";
import { getValidToken } from "@/lib/microsoft-graph";
import type {
  AuditActionRecord,
  AuditDetailByKind,
} from "./audit-repo";

export type RevertResult = { ok: true } | { ok: false; error: string };

/* ------------------------------------------------------------------ */
/* class_match_merge — delete the override row                         */
/* ------------------------------------------------------------------ */

/**
 * Undo a class_match merge by deleting the override row that was
 * inserted when the merge was applied. Idempotent: a missing override is
 * treated as success.
 *
 * We DO NOT touch any snapshots — the override is read-time logic in
 * the summary assembler, so deleting it is sufficient to "unmerge" the
 * two class_keys for all future reads. Existing snapshots stay intact.
 */
export async function revertClassMatchMerge(
  action: AuditActionRecord<"class_match_merge">,
): Promise<RevertResult> {
  const detail = action.detail as AuditDetailByKind["class_match_merge"];
  if (!detail || !detail.override_id) {
    return {
      ok: false,
      error: "audit detail missing override_id — cannot revert merge",
    };
  }
  try {
    await writeQuery(
      `DELETE FROM instinct_automation_porsche_overrides
        WHERE id = $1
          AND kind = 'class_match'`,
      [detail.override_id],
    );
    // 0 rows is fine: idempotent.
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `failed to delete override: ${(err as Error).message}`,
    };
  }
}

/* ------------------------------------------------------------------ */
/* sharepoint_upload — DELETE the file via Graph                       */
/* ------------------------------------------------------------------ */

export interface SharepointDeleteContext {
  /** Instinct user id of whoever clicked "undo". */
  userId: string;
  /** Optional fall-back anchor — the user's email/UPN. */
  userEmail?: string | null;
  /** Override the global fetch impl in tests. */
  fetchImpl?: typeof fetch;
}

interface SharepointDeleteConfig {
  siteId: string;
  driveId: string;
}

/**
 * Read site + drive from env. Returns null when either is missing —
 * caller surfaces that as a configuration error.
 *
 * Trim defensively (per memory feedback_vercel_env_trailing_newline).
 */
function loadDeleteConfig(): SharepointDeleteConfig | null {
  const siteId = (process.env.INSTINCT_SHAREPOINT_SITE_ID || "").trim();
  const driveId = (process.env.INSTINCT_SHAREPOINT_DRIVE_ID || "").trim();
  if (!siteId || !driveId) return null;
  return { siteId, driveId };
}

/**
 * Build the Graph DELETE URL by item_id (the durable handle Graph
 * returned in the upload response).
 */
export function buildDeleteUrlByItemId(
  config: SharepointDeleteConfig,
  itemId: string,
): string {
  return (
    `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(config.siteId)}` +
    `/drives/${encodeURIComponent(config.driveId)}` +
    `/items/${encodeURIComponent(itemId)}`
  );
}

/**
 * Undo a SharePoint upload by deleting the file. Soft-fails on 404 —
 * the file is already gone, the desired state is achieved.
 *
 * Auth: dual-anchor (userId first, userEmail fallback) — same pattern as
 * sharepoint-upload.ts. This means whoever clicks "undo" must have a
 * Microsoft connection; if they don't, we fail with no_token.
 *
 * NOTE: we DO NOT have an item_id when the original upload pre-dated the
 * audit logging (or when the upload response didn't include one). In
 * that case we return ok:false so the operator knows the undo couldn't
 * locate the file — they'll need to delete manually from SharePoint.
 */
export async function revertSharepointUpload(
  action: AuditActionRecord<"sharepoint_upload">,
  ctx: SharepointDeleteContext,
): Promise<RevertResult> {
  const detail = action.detail as AuditDetailByKind["sharepoint_upload"];
  if (!detail) {
    return { ok: false, error: "audit detail missing" };
  }
  if (!detail.item_id) {
    return {
      ok: false,
      error:
        "audit detail missing item_id — cannot locate SharePoint file " +
        "to delete (was the file uploaded before audit logging shipped?)",
    };
  }

  const config = loadDeleteConfig();
  if (!config) {
    return {
      ok: false,
      error:
        "SharePoint not configured — cannot revert upload (set " +
        "INSTINCT_SHAREPOINT_SITE_ID + INSTINCT_SHAREPOINT_DRIVE_ID)",
    };
  }

  // Resolve token, dual-anchor.
  let accessToken: string | null = null;
  try {
    const tok = await getValidToken(ctx.userId);
    if (tok) accessToken = tok.accessToken;
    if (!accessToken && ctx.userEmail && ctx.userEmail !== ctx.userId) {
      const fallback = await getValidToken(ctx.userEmail);
      if (fallback) accessToken = fallback.accessToken;
    }
  } catch (err) {
    return {
      ok: false,
      error: `token lookup failed: ${(err as Error).message}`,
    };
  }
  if (!accessToken) {
    return {
      ok: false,
      error: `no Microsoft token for user ${ctx.userId}`,
    };
  }

  const url = buildDeleteUrlByItemId(config, detail.item_id);
  const fetchImpl = ctx.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    return {
      ok: false,
      error: `network error during SharePoint DELETE: ${(err as Error).message}`,
    };
  }

  // 200, 204 success. 404 soft-fail — file already gone.
  if (res.status === 200 || res.status === 204 || res.status === 404) {
    return { ok: true };
  }

  let body = "";
  try {
    body = await res.text();
  } catch {
    body = "";
  }
  return {
    ok: false,
    error: `SharePoint DELETE ${res.status}: ${body.slice(0, 500)}`,
  };
}

/* ------------------------------------------------------------------ */
/* survey_auto_split — delete synthetic snapshots, restore exception   */
/* ------------------------------------------------------------------ */

/**
 * Undo an auto-split by deleting the synthetic per-class snapshots and
 * (best-effort) re-opening the original parse_failure exception so the
 * artifact still surfaces in the queue.
 *
 * Sequence:
 *   1. DELETE the synthetic snapshots (CASCADE cleans up their deltas).
 *   2. If exception_id was captured AND the row still exists, mark it
 *      open again (resolved → open). If it doesn't exist (e.g. the
 *      caller manually resolved + deleted), insert a fresh exception
 *      using `original_error` so the artifact still appears in the
 *      queue.
 *
 * Either step failing surfaces ok:false. Idempotent: re-running on a
 * partially-undone state still converges to "no synthetic snapshots,
 * one open exception".
 */
export async function revertSurveyAutoSplit(
  action: AuditActionRecord<"survey_auto_split">,
): Promise<RevertResult> {
  const detail = action.detail as AuditDetailByKind["survey_auto_split"];
  if (!detail || !Array.isArray(detail.snapshot_ids)) {
    return {
      ok: false,
      error: "audit detail missing snapshot_ids — cannot revert auto-split",
    };
  }

  // Step 1: delete the synthetic snapshots. CASCADE on the FK from
  // _deltas.curr_snapshot_id will clean up the rows the splitter wrote.
  if (detail.snapshot_ids.length > 0) {
    try {
      await writeQuery(
        `DELETE FROM instinct_automation_porsche_snapshots
          WHERE id = ANY($1::uuid[])`,
        [detail.snapshot_ids],
      );
    } catch (err) {
      // WriteQueryError preserves the underlying pg message — surface it.
      const msg =
        err instanceof WriteQueryError ? err.message : (err as Error).message;
      return {
        ok: false,
        error: `failed to delete synthetic snapshots: ${msg}`,
      };
    }
  }

  // Step 2: restore the parse_failure exception. We use the artifact_id
  // from target_ref because the exception is keyed by artifact + kind in
  // the operator's mental model.
  const artifactId = action.target_ref;
  const errMessage =
    detail.original_error ??
    "auto-split reverted — original parse failure restored";

  try {
    if (detail.exception_id) {
      // Try to re-open the original row first.
      const reopen = await writeQuery<{ id: string }>(
        `UPDATE instinct_automation_porsche_exceptions
            SET status      = 'open',
                resolved_by = NULL,
                resolved_at = NULL
          WHERE id = $1
          RETURNING id`,
        [detail.exception_id],
      );
      if (reopen.rows.length > 0) {
        return { ok: true };
      }
    }
    // Fallback: insert a fresh exception so the artifact still surfaces.
    // ON CONFLICT-style suppression isn't needed because exceptions
    // doesn't have a unique index — we accept that re-running this path
    // creates one row per attempt; idempotency is enforced at the action
    // level (the audit row is already marked reverted by then).
    await writeQuery(
      `INSERT INTO instinct_automation_porsche_exceptions
         (automation_id, artifact_id, kind, detail, status)
       VALUES ($1, $2, 'parse_failure', $3, 'open')`,
      [action.automation_id, artifactId, errMessage],
    );
    return { ok: true };
  } catch (err) {
    const msg =
      err instanceof WriteQueryError ? err.message : (err as Error).message;
    return {
      ok: false,
      error: `failed to restore parse_failure exception: ${msg}`,
    };
  }
}

/* ------------------------------------------------------------------ */
/* getOriginalSnapshotsForArtifact — helper used by tests + diagnostics */
/* ------------------------------------------------------------------ */

/**
 * Return the snapshot IDs that an artifact still owns. Used by tests
 * to confirm `revertSurveyAutoSplit` actually deleted rows.
 *
 * Not part of the revert flow itself — the revert handler doesn't read
 * back, it just acts on `detail.snapshot_ids`.
 */
export async function getSnapshotIdsForArtifact(
  artifactId: string,
): Promise<string[]> {
  const r = await query<{ id: string }>(
    `SELECT id FROM instinct_automation_porsche_snapshots
      WHERE source_artifact_id = $1`,
    [artifactId],
  );
  return r.rows.map((row) => row.id);
}
