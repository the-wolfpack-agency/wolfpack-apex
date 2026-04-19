/**
 * /api/brand/scrape — server-side brand-URL importer endpoint.
 *
 * Designer pastes a client's existing public site URL into the
 * BrandUrlImporter UI. The UI POSTs here. This route authenticates,
 * role-gates, then hands off to `importFromBrandUrl` which owns the
 * SSRF protection, the timeout, the parse, and the analytics side-effect.
 *
 * Why the lib owns analytics (not the route): the learning-loop signal
 * we care about is "which imports succeed / fail / get applied" — not
 * "which routes got hit". Keeping the trackEvent() calls inside the
 * library means any caller (future CLI ingest, nightly rescrape job,
 * etc.) contributes to the same event stream without this route being
 * on the hot path.
 *
 * Status codes:
 *   200 — scraped (ok: true) OR scraped-but-empty (ok: false, reason)
 *         We always return the `BrandImportResult` directly so the UI
 *         can show the correct copy per reason without parsing status.
 *   400 — invalid URL (can't even parse).
 *   401 — no Bearer token.
 *   403 — role < sales.
 *   504 — upstream fetch timeout (surfaces as 504 for observability).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, hasRole } from "@/lib/auth";
import { importFromBrandUrl } from "@/lib/brand-url-import";

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasRole(user.role, "sales")) {
    return NextResponse.json(
      { error: "insufficient role", reason: "role_insufficient" },
      { status: 403 },
    );
  }

  let body: { url?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const url = typeof body.url === "string" ? body.url : "";
  if (!url) {
    return NextResponse.json(
      { error: "url required" },
      { status: 400 },
    );
  }

  const result = await importFromBrandUrl(
    { url },
    { user: { id: user.id, role: user.role } },
  );
  if (!result.ok && result.reason === "invalid_url") {
    return NextResponse.json(result, { status: 400 });
  }
  if (!result.ok && result.reason === "timeout") {
    return NextResponse.json(result, { status: 504 });
  }
  return NextResponse.json(result, { status: 200 });
}
