import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { safeQuery } from "@/lib/db";
import { renderReportHtml } from "@/lib/report-templates";
import { trackEvent } from "@/lib/analytics";

/**
 * GET /api/reports/[id] — Get a specific generated report.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const { rows } = await safeQuery<{
    id: string;
    title: string;
    content: string;
    doc_type: string;
    generated_from: string | null;
    generated_by: string;
    created_at: string;
  }>(
    `SELECT id, title, content, doc_type, generated_from, generated_by, created_at
     FROM apex_documents WHERE id = $1 AND doc_type = 'report'
     AND (generated_by = $2 OR $3 IN ('cto', 'ceo'))`,
    [id, user.id, user.role],
  );

  if (rows.length === 0) {
    trackEvent("system.unauthorized_access_attempt", user.id, user.role, { resource: "report", resource_id: id });
    return NextResponse.json({ error: "Report not found" }, { status: 404 });
  }

  const row = rows[0];
  const html = renderReportHtml(row.content);

  return NextResponse.json({
    reportId: row.id,
    title: row.title,
    markdown: row.content,
    html,
    templateId: row.generated_from,
    generatedBy: row.generated_by,
    generatedAt: row.created_at,
  });
}
