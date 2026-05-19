/**
 * Meeting Pre-Brief — top-level entry point.
 *
 * Composes the source fan-out + cache lookup + (cache-miss) single LLM
 * call. This is the function tool handlers + the API route call.
 *
 * Cache contract:
 *   - Lookup keyed by (workspace_id, meeting_id, source_hash) WHERE
 *     invalidated_at IS NULL. Active row = cache hit; the LLM is never
 *     invoked on a hit. Hit count is bumped so the learning loop sees
 *     which prebriefs get re-opened.
 *   - Cache miss runs synthesizePrep() — exactly one LLM call — and
 *     persists the row. Conflict on (workspace_id, meeting_id,
 *     source_hash) triggers a no-op upsert so two concurrent callers
 *     don't double-write.
 *   - Stale rows (matching workspace + meeting but a DIFFERENT
 *     source_hash) are left in place; the lookup index only returns
 *     active rows by source_hash. Cleanup is a future migration.
 */

import { safeQuery, WriteQueryError } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import {
  fetchMeetingSources,
  computeSourceHash,
  type MeetingSources,
} from "./meeting-prep-sources";
import {
  synthesizePrep,
  type MeetingPrep,
  type SynthesisResult,
} from "./meeting-prep-synthesize";

/* --------------------------- Types ------------------------------------ */

export type CacheStatus = "hit" | "miss" | "regenerated";

export interface PrepareMeetingContext {
  workspaceId: string;
  userId: string;
  userRole?: string;
  /** When true, the lookup is bypassed and any active row for the meeting
   *  is invalidated before a fresh synthesis. Used by the "regenerate"
   *  button (manager+ only — gated in the widget). */
  force?: boolean;
}

export interface PrepareMeetingResult {
  prep: MeetingPrep | null;
  /** Always populated — the raw fan-out blob the synthesis was based on.
   *  Returned alongside the prep so the route can degrade gracefully
   *  (synthesis_unavailable flag with raw sources visible). */
  sources: MeetingSources;
  sourceHash: string;
  cacheStatus: CacheStatus;
  generatedAt: string;
  synthesisUnavailable: boolean;
  /** When synthesis failed, the human-readable reason. Surfaced into
   *  analytics so the learning loop sees which failure mode bites. */
  synthesisErrorCode?: string;
}

/* --------------------------- Cache row -------------------------------- */

interface CacheRow {
  id: string;
  insight_json: MeetingPrep;
  generated_at: string;
  hit_count: number;
}

async function lookupCache(
  workspaceId: string,
  meetingId: string,
  sourceHash: string,
): Promise<CacheRow | null> {
  try {
    const { rows } = await safeQuery<{
      id: string;
      insight_json: MeetingPrep | string;
      generated_at: string;
      hit_count: number;
    }>(
      `SELECT id, insight_json, generated_at::text AS generated_at, hit_count
         FROM instinct_meeting_insights
        WHERE workspace_id = $1
          AND meeting_id   = $2
          AND source_hash  = $3
          AND invalidated_at IS NULL
        LIMIT 1`,
      [workspaceId, meetingId, sourceHash],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    /* JSONB is typically returned as already-parsed object; defensively
     * handle the string variant (some pg builds return text). */
    const insight =
      typeof row.insight_json === "string"
        ? (JSON.parse(row.insight_json) as MeetingPrep)
        : row.insight_json;
    return {
      id: row.id,
      insight_json: insight,
      generated_at: row.generated_at,
      hit_count: row.hit_count,
    };
  } catch {
    return null;
  }
}

async function bumpHitCount(id: string): Promise<void> {
  try {
    await safeQuery(
      `UPDATE instinct_meeting_insights
          SET hit_count = hit_count + 1
        WHERE id = $1`,
      [id],
    );
  } catch {
    /* Non-fatal — the user already has their cached answer. */
  }
}

async function persistCache(args: {
  workspaceId: string;
  meetingId: string;
  sourceHash: string;
  prep: MeetingPrep;
  userId: string;
}): Promise<string | null> {
  try {
    const { rows } = await safeQuery<{ id: string; generated_at: string }>(
      `INSERT INTO instinct_meeting_insights
          (workspace_id, meeting_id, source_hash, insight_json, generated_by_user_id)
        VALUES ($1, $2, $3, $4::jsonb, $5)
        ON CONFLICT (workspace_id, meeting_id, source_hash)
          WHERE invalidated_at IS NULL
          DO UPDATE SET hit_count = instinct_meeting_insights.hit_count
        RETURNING id, generated_at::text AS generated_at`,
      [
        args.workspaceId,
        args.meetingId,
        args.sourceHash,
        JSON.stringify(args.prep),
        args.userId,
      ],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    if (err instanceof WriteQueryError) {
      console.warn("[meeting-prep] persist failed:", err.message);
    }
    return null;
  }
}

async function invalidateActiveRows(
  workspaceId: string,
  meetingId: string,
): Promise<void> {
  try {
    await safeQuery(
      `UPDATE instinct_meeting_insights
          SET invalidated_at = NOW()
        WHERE workspace_id = $1
          AND meeting_id   = $2
          AND invalidated_at IS NULL`,
      [workspaceId, meetingId],
    );
  } catch {
    /* Non-fatal — the cache miss will land a fresh row anyway. */
  }
}

/* --------------------------- Entry point ------------------------------ */

export async function prepareMeeting(
  eventId: string,
  ctx: PrepareMeetingContext,
): Promise<PrepareMeetingResult | null> {
  const sources = await fetchMeetingSources(eventId, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    userRole: ctx.userRole,
  });
  if (!sources) {
    return null;
  }

  const sourceHash = computeSourceHash(sources.versionMarkers);

  /* Force-regenerate path: invalidate before lookup so the lookup misses
   * and the LLM is called fresh. Emit the regenerated event separately
   * from the standard cache-miss event so the learning loop can
   * distinguish "stale data triggered a refresh" from "manager clicked
   * the button". */
  if (ctx.force) {
    await invalidateActiveRows(ctx.workspaceId, eventId);
  }

  if (!ctx.force) {
    const hit = await lookupCache(ctx.workspaceId, eventId, sourceHash);
    if (hit) {
      void bumpHitCount(hit.id);
      void trackEvent(
        "assistant.meeting_prep_cache_hit",
        ctx.userId,
        ctx.userRole ?? "unknown",
        {
          meeting_id: eventId,
          workspace_id: ctx.workspaceId,
          source_hash: sourceHash,
          hit_count: hit.hit_count + 1,
        },
      );
      return {
        prep: hit.insight_json,
        sources,
        sourceHash,
        cacheStatus: "hit",
        generatedAt: hit.generated_at,
        synthesisUnavailable: false,
      };
    }
  }

  /* Cache miss — run the single LLM call. */
  const synthResult: SynthesisResult = await synthesizePrep(sources, {
    userId: ctx.userId,
    userRole: ctx.userRole,
  });

  if (!synthResult.ok) {
    void trackEvent(
      "assistant.meeting_prep_synthesis_failed",
      ctx.userId,
      ctx.userRole ?? "unknown",
      {
        meeting_id: eventId,
        workspace_id: ctx.workspaceId,
        code: synthResult.code,
        message: synthResult.message.slice(0, 280),
      },
    );
    return {
      prep: null,
      sources,
      sourceHash,
      cacheStatus: ctx.force ? "regenerated" : "miss",
      generatedAt: new Date().toISOString(),
      synthesisUnavailable: true,
      synthesisErrorCode: synthResult.code,
    };
  }

  await persistCache({
    workspaceId: ctx.workspaceId,
    meetingId: eventId,
    sourceHash,
    prep: synthResult.prep,
    userId: ctx.userId,
  });

  void trackEvent(
    ctx.force
      ? "assistant.meeting_prep_regenerated"
      : "assistant.meeting_prep_cache_miss",
    ctx.userId,
    ctx.userRole ?? "unknown",
    {
      meeting_id: eventId,
      workspace_id: ctx.workspaceId,
      source_hash: sourceHash,
      latency_ms: synthResult.latencyMs,
      model_used: synthResult.modelUsed,
      input_tokens: synthResult.inputTokens,
      output_tokens: synthResult.outputTokens,
    },
  );

  void trackEvent(
    "assistant.meeting_prep_executed",
    ctx.userId,
    ctx.userRole ?? "unknown",
    {
      meeting_id: eventId,
      workspace_id: ctx.workspaceId,
      cache_status: ctx.force ? "regenerated" : "miss",
    },
  );

  return {
    prep: synthResult.prep,
    sources,
    sourceHash,
    cacheStatus: ctx.force ? "regenerated" : "miss",
    generatedAt: new Date().toISOString(),
    synthesisUnavailable: false,
  };
}

/* --------------------- Learning-loop signal write --------------------- */

/**
 * Persist a click/expand signal against a cached insight. The signal
 * feeds the next-synthesis prompt-weight tuning (which talking points
 * drive engagement) so high-value framing isn't lost across cache
 * refreshes. Mirrors the brief-edit learning surface.
 */
export async function recordPrepSignal(args: {
  workspaceId: string;
  meetingId: string;
  insightId: string;
  userId: string;
  userRole: string;
  kind:
    | "talking_point_expanded"
    | "source_clicked"
    | "risk_flag_viewed"
    | "regenerate_clicked";
  itemIndex?: number;
  refType?: string;
}): Promise<void> {
  try {
    await safeQuery(
      `INSERT INTO instinct_meeting_prep_signals
          (workspace_id, insight_id, meeting_id, user_id, user_role,
           kind, item_index, ref_type)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        args.workspaceId,
        args.insightId,
        args.meetingId,
        args.userId,
        args.userRole,
        args.kind,
        args.itemIndex ?? null,
        args.refType ?? null,
      ],
    );
  } catch {
    /* Non-fatal — analytics still captures the event on the route. */
  }
}
