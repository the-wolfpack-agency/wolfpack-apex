import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";
import { listPages, getPage, upsertPage, type WikiPage } from "@/lib/engineering";
import { renderMarkdown } from "@/lib/markdown";

/** Attach server-rendered, sanitized HTML so the client never imports the
 *  sanitizer (jsdom/dompurify is Node-only and breaks the client bundle). */
const withHtml = (p: WikiPage): WikiPage => ({ ...p, bodyHtml: renderMarkdown(p.body) });

/**
 * GET /api/engineering: list published wiki pages, or one page by ?slug.
 *
 * Org-wide read (engineering.view). Powers the /engineering wiki. With ?slug it
 * returns a single page (404 when unknown); without it, the full page list.
 */
export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "engineering.view");
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const slug = url.searchParams.get("slug");

  if (slug) {
    const page = await getPage(slug);
    if (!page) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ page: withHtml(page) });
  }

  const pages = await listPages();

  trackEvent("engineering.viewed", auth.user.id, auth.user.role, {
    count: pages.length,
  });

  return NextResponse.json({ pages: pages.map(withHtml) });
}

/**
 * POST /api/engineering: create or update (upsert) a wiki page.
 *
 * Gated (engineering.manage). Used by the in-app editor and the seed path.
 * Body: { slug, parentSlug?, title, body?, position?, published? }.
 */
export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "engineering.manage");
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!slug || !title) {
    return NextResponse.json(
      { error: "slug and title are required" },
      { status: 400 },
    );
  }

  const page = await upsertPage({
    slug,
    parentSlug: typeof body.parentSlug === "string" ? body.parentSlug : null,
    title,
    body: typeof body.body === "string" ? body.body : "",
    position: typeof body.position === "number" ? body.position : undefined,
    published: typeof body.published === "boolean" ? body.published : undefined,
    createdBy: auth.user.id,
  });

  trackEvent("engineering.published", auth.user.id, auth.user.role, {
    slug: page.slug,
  });

  // Compliance record: who published which wiki page.
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "engineering.published",
    resourceType: "engineering_page",
    resourceId: page.slug,
    afterState: {
      slug: page.slug,
      title: page.title,
      published: page.published,
    },
  });

  return NextResponse.json({ page }, { status: 201 });
}
