/**
 * GET /api/admin/forcefield/docs           -> the list of GTM docs (no bodies)
 * GET /api/admin/forcefield/docs?doc=<key>  -> one doc rendered to safe HTML
 *
 * Surfaces the Forcefield GTM / launch docs IN THE APP for the team, instead of
 * repo-only markdown. The docs are internal DRAFT (pricing, legal), so this is
 * capability-gated (settings.manage_team). Read-only; the key is whitelisted by
 * the registry, so there is no arbitrary-path read. Markdown is rendered by the
 * shared safe-by-construction renderer (no raw HTML passthrough).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { listGtmDocs, gtmDocByKey, readGtmDoc } from "@/lib/forcefield-web/gtm-docs";
import { renderMarkdown } from "@/lib/markdown";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const docs = listGtmDocs();
  const key = req.nextUrl.searchParams.get("doc");
  if (!key) {
    return NextResponse.json({ docs });
  }
  const meta = gtmDocByKey(key);
  if (!meta) {
    return NextResponse.json({ ok: false, error: "unknown_doc" }, { status: 404 });
  }
  const md = readGtmDoc(key);
  if (md == null) {
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, docs, doc: meta, html: renderMarkdown(md) });
}
