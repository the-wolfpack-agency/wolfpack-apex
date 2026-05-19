/**
 * GET /api/portal/salesforce/list?type=contacts|opportunities|accounts&q=&stage=&limit=&offset=
 *
 * Lists records of one type. Pure passthrough to connector.searchRecords
 * with two extensions:
 *   - When `q` is empty, we use a wildcard ("a") so a "show me everything"
 *     request still returns rows. The vendor preset's SOQL search
 *     requires at least 2 chars; "a" matches any name containing 'a'.
 *   - `stage` filter (comma-separated for multi-select) is applied
 *     server-side after the search, since the basic SF search builder
 *     doesn't take a stage clause (the filterSearch tool does, but we
 *     don't need date/amount filtering here — just stage chips).
 *
 * Cursor: simple offset-based. Salesforce supports nextRecordsUrl for
 * true pagination but the portal MVP only needs Load More semantics.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import {
  resolveSalesforceConnector,
  connectorErrorToHttp,
  isPortalType,
  portalTypeToObject,
} from "../_helpers";

interface ListResponse {
  notConfigured: boolean;
  records: Array<Record<string, unknown>>;
  hasMore: boolean;
  connector: string;
}

const MAX_LIMIT = 200;

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const type = url.searchParams.get("type");
  if (!isPortalType(type)) {
    return NextResponse.json(
      { error: "type must be contacts | opportunities | accounts", code: "validation" },
      { status: 400 },
    );
  }
  /* q defaults to a single char so the search builder validates and SF
     returns "everything". Users typing a 1-char search still hit this
     branch — they get the wildcard until they type the 2nd char, which
     matches what universal search does. */
  const rawQ = url.searchParams.get("q") ?? "";
  const q = rawQ.trim().length >= 2 ? rawQ.trim() : "a";
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, MAX_LIMIT);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1000);
  const stageRaw = url.searchParams.get("stage") ?? "";
  const stageFilters = stageRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const workspaceId = auth.user.workspaceId;
  const resolved = await resolveSalesforceConnector(workspaceId);
  if (resolved.notConfigured) {
    return NextResponse.json({
      notConfigured: true,
      records: [],
      hasMore: false,
      connector: resolved.connectorName,
    } satisfies ListResponse);
  }

  const objectType = portalTypeToObject(type);
  /* For offset-based load more we ask for limit+offset+1 then slice —
     the +1 tells us whether there's another page. SF SOQL doesn't
     natively support OFFSET in the search-builder path, so we
     over-fetch and slice client-side here. */
  const overFetch = Math.min(MAX_LIMIT, limit + offset + 1);
  const result = await resolved.connector.searchRecords(objectType, q, overFetch);
  if (!result.ok) {
    const mapped = connectorErrorToHttp(result.code);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
  let records = result.data ?? [];

  /* Stage filtering for opportunities. We do it server-side after the
     SOQL because the search builder we hit is the bare name-search and
     doesn't compose stage clauses. */
  if (objectType === "opportunity" && stageFilters.length > 0) {
    records = records.filter((r) => {
      const s = typeof r.StageName === "string" ? r.StageName : "";
      return stageFilters.includes(s);
    });
  }

  const sliced = records.slice(offset, offset + limit);
  const hasMore = records.length > offset + limit;

  trackEvent("portal.salesforce_list_viewed", auth.user.id, auth.user.role, {
    type,
    query_length: rawQ.length,
    result_count: sliced.length,
    connector: resolved.connectorName,
    stage_filters: stageFilters.join("|"),
  });

  return NextResponse.json({
    notConfigured: false,
    records: sliced,
    hasMore,
    connector: resolved.connectorName,
  } satisfies ListResponse);
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
