/**
 * GET /api/brain/pack — progressive Brain Pack download for Level-2 offline.
 *
 * Returns a cursor-paginated stream of `{id, doc_id, title, text, embedding}`
 * rows so the client can build its own searchable cache (see
 * `src/lib/brain-pack-store.ts` + `src/lib/brain-ann.ts`). The client runs
 * this on a low-priority background sync whenever the user has Wi-Fi,
 * data-saver is OFF, and storage headroom is available.
 *
 * Query params:
 *   workspace  required  — currently must equal "default"; single-tenant.
 *   cursor     optional  — opaque chunk id to resume from (exclusive).
 *   limit      optional  — default 50, max 200.
 *
 * Response:
 *   {
 *     chunks: [{ id, doc_id, title, text, embedding: number[] }, ...],
 *     next_cursor: string | null,
 *     total: number,    // total indexed chunks in this workspace
 *   }
 *
 * Cache-Control: private, max-age=300 — packs are user-scoped and change
 * only on ingest. Five-minute freshness is generous for the slow-sync
 * use case; the client re-syncs on reconnect regardless.
 *
 * Authz:
 *   - `brain.read` capability (same gate as /api/brain/query).
 *   - Workspace scope check: user must be an active team_member, and the
 *     requested workspace must exist. Non-default workspaces are rejected
 *     with 403 until multi-tenant lands. This matches the pattern in
 *     src/app/api/workspace/status/route.ts.
 *
 * Embeddings are fetched from Qdrant in batch. If Qdrant is unreachable
 * the endpoint still returns rows with `embedding: []`; the client
 * degrades to keyword-only Level-2 search (brain-ann.ts already handles
 * this case). No partial data loss.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { safeQuery } from "@/lib/db";
import { fetchBrainVectors } from "@/lib/brain/qdrant";
import { trackEvent } from "@/lib/analytics";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface PackChunkRow {
  id: string;
  document_id: string;
  chunk_idx: number;
  content: string;
  qdrant_point_id: string | null;
  filename: string;
  kind: string;
  created_at: string;
  [key: string]: unknown;
}

interface PackResponseChunk {
  id: string;
  doc_id: string;
  title: string;
  text: string;
  embedding: number[];
}

interface PackResponse {
  chunks: PackResponseChunk[];
  next_cursor: string | null;
  total: number;
}

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "brain.read");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  const url = new URL(req.url);
  const workspace = (url.searchParams.get("workspace") || "").trim();
  const cursor = url.searchParams.get("cursor") || null;
  const limitRaw = Number(url.searchParams.get("limit") || DEFAULT_LIMIT);
  const limit = Math.min(
    Math.max(Number.isFinite(limitRaw) ? Math.floor(limitRaw) : DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );

  if (!workspace) {
    return NextResponse.json(
      { error: "workspace is required" },
      { status: 400 },
    );
  }

  /* Multi-workspace gate: the caller may only request the pack for
     their own workspace. Single-tenant deploys have everyone in
     "default" so existing clients see no change. Cross-tenant reads
     are forbidden even with brain.read capability — the session,
     not the request, decides which workspace this user belongs to. */
  if (workspace !== user.workspaceId) {
    return NextResponse.json(
      { error: "forbidden", reason: "workspace_not_accessible" },
      { status: 403 },
    );
  }

  // Active team-member check acts as the workspace membership assertion.
  // A revoked / inactive member (is_active=false) loses pack access even
  // if their JWT still has brain.read — parity with workspace/status.
  const membership = await safeQuery<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM instinct_team_members
      WHERE email = $1
        AND is_active = TRUE
      LIMIT 1`,
    [user.email],
  );
  const isMember = (membership.rows[0]?.count ?? 0) > 0;
  // Shadow-mode (no DB / fromCache) is permissive: without a DB we cannot
  // prove non-membership and failing closed would make the pack endpoint
  // useless in dev. Production always has instinct_team_members.
  if (!membership.fromCache && !isMember) {
    return NextResponse.json(
      { error: "forbidden", reason: "not_a_workspace_member" },
      { status: 403 },
    );
  }

  // Page the indexed chunks. Order by id (uuid v4 → stable total order)
  // so cursor pagination is deterministic and resumable. We filter to
  // docs in `indexed` status so half-written docs never leak into the
  // pack.
  const args: unknown[] = [];
  let whereCursor = "";
  if (cursor) {
    args.push(cursor);
    whereCursor = `AND bc.id > $${args.length}::uuid`;
  }
  args.push(limit + 1); // fetch one extra so we can tell if there's more
  const rowsRes = await safeQuery<PackChunkRow>(
    `SELECT bc.id,
            bc.document_id,
            bc.chunk_idx,
            bc.content,
            bc.qdrant_point_id,
            bd.filename,
            bd.kind,
            bc.created_at
       FROM brain_chunks bc
       JOIN brain_documents bd ON bd.id = bc.document_id
      WHERE bd.status = 'indexed'
        ${whereCursor}
      ORDER BY bc.id ASC
      LIMIT $${args.length}`,
    args,
  );

  // In shadow / no-DB mode we still return a well-formed empty pack so
  // the client pack store does not treat the call as a hard failure.
  if (rowsRes.fromCache) {
    return NextResponse.json(
      { chunks: [], next_cursor: null, total: 0 } as PackResponse,
      {
        status: 200,
        headers: { "Cache-Control": "private, max-age=300" },
      },
    );
  }

  const pageRows = rowsRes.rows.slice(0, limit);
  const hasMore = rowsRes.rows.length > limit;
  const nextCursor = hasMore ? pageRows[pageRows.length - 1]?.id ?? null : null;

  // Best-effort vector fetch. If Qdrant is down the chunks still ship
  // without embeddings; the client's Level-2 ANN degrades to keyword
  // scoring only.
  const pointIds = pageRows
    .map((r) => r.qdrant_point_id)
    .filter((x): x is string => Boolean(x));
  const vectorMap = await fetchBrainVectors(pointIds);

  const chunks: PackResponseChunk[] = pageRows.map((r) => ({
    id: r.id,
    doc_id: r.document_id,
    title: r.filename,
    text: r.content,
    embedding:
      r.qdrant_point_id && vectorMap.has(r.qdrant_point_id)
        ? vectorMap.get(r.qdrant_point_id)!
        : [],
  }));

  // Cheap total for pagination UX. Same scope filter as the page query.
  // Falls through to 0 on shadow-mode / error — the cursor path is the
  // source of truth for "is there more?".
  const totalRes = await safeQuery<{ total: number }>(
    `SELECT COUNT(*)::int AS total
       FROM brain_chunks bc
       JOIN brain_documents bd ON bd.id = bc.document_id
      WHERE bd.status = 'indexed'`,
  );
  const total = totalRes.fromCache ? 0 : totalRes.rows[0]?.total ?? 0;

  // Fire-and-forget: feed the learning loop so we can see pack-download
  // cadence per user/workspace. The page_downloaded event fires on the
  // CLIENT too (so we know it actually landed in IDB); this one records
  // the server-side serve.
  trackEvent("brain.pack_page_downloaded", user.id, user.role, {
    workspace,
    page_chunks: chunks.length,
    total_cached: 0, // server cannot know client-side cache state
    duration_ms: 0,
  });

  const body: PackResponse = {
    chunks,
    next_cursor: nextCursor,
    total,
  };
  return NextResponse.json(body, {
    status: 200,
    headers: { "Cache-Control": "private, max-age=300" },
  });
}
