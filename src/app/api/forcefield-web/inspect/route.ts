/**
 * POST /api/forcefield-web/inspect - the watch-and-report ingest seam.
 *
 * A site (or its middleware) sends one normalized request; Forcefield classifies
 * it against the site's config, decides an action under the site's posture, and
 * RECORDS the inspection so it shows on the protection dashboard. Returns the
 * decision so a caller in enforce mode can act on a "block".
 *
 * This is the watch-first seam. It is capability-gated for the internal/demo
 * path today; the production integration is a site key at the network edge,
 * feeding the same classify -> decide -> record core. Nothing here hard-blocks
 * on its own; the caller decides whether to honor a "block".
 *
 * Responses:
 *   200 { verdict, decision }
 *   400 invalid_input
 *   401 / 403  via requireCapability
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { classifyWebRequest, type SiteForcefieldConfig } from "@/lib/forcefield-web/classify";
import { decideWebAction, type WebPosture } from "@/lib/forcefield-web/posture";
import { recordWebInspection, liveRecordWebDeps } from "@/lib/forcefield-web/record";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface InspectBody {
  path?: unknown;
  method?: unknown;
  userAgent?: unknown;
  site?: unknown;
  posture?: unknown;
  trapPaths?: unknown;
  knownAgents?: unknown;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const workspaceId = auth.user.workspaceId ?? "default";

  let body: InspectBody = {};
  try {
    body = (await req.json()) as InspectBody;
  } catch {
    return NextResponse.json({ error: "invalid_input", detail: "body must be JSON" }, { status: 400 });
  }

  const path = typeof body.path === "string" ? body.path : "";
  const method = typeof body.method === "string" ? body.method : "GET";
  const userAgent = typeof body.userAgent === "string" ? body.userAgent : "";
  const site = typeof body.site === "string" && body.site.trim() ? body.site.trim() : "default";
  const posture: WebPosture = body.posture === "enforce" ? "enforce" : "monitor";
  if (!path) {
    return NextResponse.json({ error: "invalid_input", detail: "path is required" }, { status: 400 });
  }

  const knownAgents = Array.isArray(body.knownAgents)
    ? body.knownAgents
        .filter((a): a is { id: unknown; uaMatch: unknown } => !!a && typeof a === "object")
        .map((a) => ({ id: String((a as { id: unknown }).id ?? ""), uaMatch: String((a as { uaMatch: unknown }).uaMatch ?? "") }))
        .filter((a) => a.id && a.uaMatch)
    : [];
  const config: SiteForcefieldConfig = { trapPaths: asStringArray(body.trapPaths), knownAgents };

  const verdict = classifyWebRequest({ path, method, userAgent }, config);
  const decision = decideWebAction(verdict, posture);
  recordWebInspection({ workspaceId, site, verdict, decision }, liveRecordWebDeps());

  return NextResponse.json({ verdict, decision });
}
