/**
 * GET /api/admin/audit-log/export
 *
 * Streams the entire audit log (or a filtered slice) as NDJSON for offline
 * storage or compliance handoff. Rate-limited to 3 exports per user per hour —
 * bulk download is inherently heavy and should not be routine.
 *
 * Emits `system.audit_log_export`.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { queryAuditLog, verifyChain, GENESIS_HASH } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { effectiveCapabilitiesFor } from "@/lib/auth/require-capability";
import type { Capability } from "@/lib/auth/capabilities";

const AUDIT_CAPABILITY = "admin.audit_log.view" as Capability;

const EXPORT_LIMIT_PER_HOUR = 3;
const EXPORT_WINDOW_MS = 60 * 60 * 1000;
const exportAttempts = new Map<string, { count: number; resetAt: number }>();

function rateLimit(userId: string): { limited: boolean; retryAfter: number } {
  const now = Date.now();
  const entry = exportAttempts.get(userId);
  if (!entry || now >= entry.resetAt) {
    exportAttempts.set(userId, { count: 1, resetAt: now + EXPORT_WINDOW_MS });
    return { limited: false, retryAfter: 0 };
  }
  entry.count++;
  if (entry.count > EXPORT_LIMIT_PER_HOUR) {
    return { limited: true, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { limited: false, retryAfter: 0 };
}

async function checkAuth(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return { ok: false as const, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (user.role === "ceo" || user.role === "cto" || user.role === "evp") return { ok: true as const, user };
  try {
    const { capabilities } = await effectiveCapabilitiesFor(user);
    if (capabilities.has(AUDIT_CAPABILITY)) return { ok: true as const, user };
  } catch {
    // ignore
  }
  return { ok: false as const, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
}

/**
 * The first and last seq in the exported slice.
 *
 * Verification is scoped to what the file contains: verifying the WHOLE chain
 * would report a break in a range the reader was never given, which is a
 * different document's problem and reads as this one's.
 */
async function exportedSeqRange(
  filter: Parameters<typeof queryAuditLog>[0],
): Promise<{ from: number; to: number } | null> {
  const first = await queryAuditLog({ ...filter, limit: 1 });
  if (first.entries.length === 0) return null;
  const seqs = first.entries.map((e) => e.seq);
  let cursor = first.nextCursor;
  let last = seqs[seqs.length - 1];
  /* Walk to the end using the same pagination the export uses, so the range
     matches the rows exactly rather than approximately. */
  let guard = 0;
  while (cursor && guard < 500) {
    const page = await queryAuditLog({ ...filter, cursor });
    if (page.entries.length === 0) break;
    last = page.entries[page.entries.length - 1].seq;
    cursor = page.nextCursor;
    guard += 1;
  }
  const from = Math.min(seqs[0], last);
  const to = Math.max(seqs[0], last);
  return { from, to };
}

export async function GET(req: NextRequest) {
  const auth = await checkAuth(req);
  if (!auth.ok) return auth.response;
  const { user } = auth;

  const { limited, retryAfter } = rateLimit(user.id);
  if (limited) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const params = req.nextUrl.searchParams;
  const sinceStr = params.get("since");
  const untilStr = params.get("until");
  const filter = {
    actorUserId: params.get("actor_user_id") ?? undefined,
    resourceType: params.get("resource_type") ?? undefined,
    resourceId: params.get("resource_id") ?? undefined,
    action: params.get("action") ?? undefined,
    since: sinceStr ? new Date(sinceStr) : undefined,
    until: untilStr ? new Date(untilStr) : undefined,
    limit: 500,
  };

  // Accumulate all pages (bounded overall by DB row count; single operator
  // consuming via NDJSON is expected). For truly massive tables, prefer a
  // background job + signed URL; this is the MVP path.
  const lines: string[] = [];
  let cursor: string | undefined;
  let totalEmitted = 0;
  do {
    const page = await queryAuditLog({ ...filter, cursor });
    for (const entry of page.entries) {
      lines.push(JSON.stringify(entry));
    }
    totalEmitted += page.entries.length;
    cursor = page.nextCursor;
  } while (cursor && totalEmitted < 50_000); // hard safety cap

  /* A MANIFEST LINE, FIRST, so the file can be checked without asking us.
   *
   * The rows already carry entry_hash and prev_hash, which is everything an
   * auditor needs to walk the chain, and nothing said what to DO with them: no
   * algorithm, no canonicalisation, no genesis value, and no statement of
   * whether the chain verified at the moment of export. A hash somebody cannot
   * reproduce is decoration.
   *
   * The verdict travels IN the file deliberately. An export that omitted a
   * failing chain would be worse than no export, because it would look clean.
   *
   * NDJSON, so this is one more line rather than a new shape: a consumer that
   * reads rows and ignores unknown objects is unaffected, and one that cares
   * checks `document`. */
  const seqs = lines.length > 0 ? await exportedSeqRange(filter) : null;
  const verification = seqs ? await verifyChain(seqs.from, seqs.to) : { valid: true, checkedCount: 0 };
  const manifest = {
    document: "instinct-audit-export",
    generated_at: new Date().toISOString(),
    row_count: totalEmitted,
    truncated: totalEmitted >= 50_000,
    chain: {
      algorithm: "sha256(prev_hash || canonical_json(entry_without_hashes))",
      canonicalisation: "JSON with object keys sorted, no insignificant whitespace",
      genesis_hash: GENESIS_HASH,
      /* Verified over exactly the range in this file, at the time it was
         produced. A later verdict says nothing about this document. */
      verified_at_export: verification,
    },
  };

  const body = [JSON.stringify(manifest), ...lines].join("\n") + "\n";

  trackEvent("system.audit_log_export", user.id, user.role, {
    exported_count: totalEmitted,
    filters_applied:
      Number(Boolean(filter.actorUserId)) +
      Number(Boolean(filter.resourceType)) +
      Number(Boolean(filter.resourceId)) +
      Number(Boolean(filter.action)) +
      Number(Boolean(sinceStr)) +
      Number(Boolean(untilStr)),
  });

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "Content-Disposition": `attachment; filename="instinct-audit-log-${new Date()
        .toISOString()
        .slice(0, 10)}.ndjson"`,
    },
  });
}

// Exposed for tests
export { exportAttempts, EXPORT_LIMIT_PER_HOUR };
