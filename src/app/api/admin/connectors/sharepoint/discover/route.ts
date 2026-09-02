/**
 * GET /api/admin/connectors/sharepoint/discover
 *   200 { reachable, unconnected, couldNotAsk, lines } | 401 | 403
 *
 * What the connected accounts can reach in SharePoint, against what we hold a
 * source for. It runs here rather than in a script because Graph needs the
 * Microsoft credentials, which exist on the server and nowhere else.
 *
 * READ ONLY, deliberately and permanently. It connects nothing. Something that
 * silently attached itself to whatever it could see in a client's tenant would
 * be a far worse thing to deploy than the gap it closes.
 *
 * Gated the way the library repair is: the scheduled caller presents
 * CRON_SECRET, a person needs settings.manage_team. Searching as every
 * connected account is not something a viewer should be able to set off.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { query } from "@/lib/db";
import { getValidToken } from "@/lib/microsoft-graph";
import { searchSharePoint } from "@/lib/integrations/microsoft-sharepoint";
import {
  discoverReach,
  describeDiscovery,
  type SearchAs,
} from "@/lib/connectors/sharepoint/discover";

const NO_STORE = { "Cache-Control": "no-store" };

/** One Graph request per connected account. A handful of accounts, not a crawl. */
export const maxDuration = 120;

function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) {
    const auth = await requireCapability(req, "settings.manage_team");
    if (!auth.ok) return auth.response;
  }

  const workspaceId = "default";

  const { rows: accounts } = await query<{ connected_by: string; user_email: string }>(
    `SELECT connected_by, user_email FROM instinct_ms_tokens ORDER BY user_email`,
  );
  const { rows: sources } = await query<{ site_url: string }>(
    `SELECT site_url FROM instinct_sharepoint_sources WHERE workspace_id = $1`,
    [workspaceId],
  );

  const keyFor = new Map(accounts.map((a) => [a.user_email, a.connected_by]));

  const searchAs: SearchAs = async ({ email }) => {
    const token = await getValidToken(keyFor.get(email) ?? email);
    /* NOT "reaches nothing". An account we cannot ask makes the gap look
       smaller exactly when the connection is broken, which is when the report
       matters most. */
    if (!token) return { ok: false, reason: "no_token" };

    const res = await searchSharePoint(token.accessToken, {
      /* A wildcard, because the question is "what is there", not "what matches
         this". driveItem alone: the other entity types need Sites.Read.All,
         and Graph fails the WHOLE request when the token cannot cover every
         type asked for, which is how 171 lookups 401'd for three months. */
      query: "*",
      topN: 25,
      entityTypes: ["driveItem"],
    });
    if (!res.ok) return { ok: false, reason: res.code };
    return { ok: true, hits: res.value.hits.map((h) => ({ url: h.url })) };
  };

  const report = await discoverReach(
    accounts.map((a) => ({ email: a.user_email })),
    searchAs,
    sources.map((s) => s.site_url),
  );

  return NextResponse.json(
    { ok: true, ...report, lines: describeDiscovery(report) },
    { status: 200, headers: NO_STORE },
  );
}
