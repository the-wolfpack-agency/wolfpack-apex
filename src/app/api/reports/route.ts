import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import {
  getTemplates,
  generateReport,
  getReportHistory,
} from "@/lib/report-templates";

/**
 * GET /api/reports — List templates and past reports.
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const templates = getTemplates().map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      sections: t.sections.map((s) => ({
        id: s.id,
        title: s.title,
        description: s.description,
        dataSource: s.dataSource,
      })),
      defaultIncluded: t.defaultIncluded,
    }));

    const history = await getReportHistory(req.nextUrl.searchParams.get("mine") === "true" ? user.id : undefined);

    trackEvent("system.page_viewed", user.id, user.role, { page: "reports" });

    return NextResponse.json({ templates, history });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to list reports", detail: (err as Error).message },
      { status: 500 },
    );
  }
}

/**
 * POST /api/reports — Generate a branded report.
 *
 * Body: { templateId, sections: string[], context: { clientName, ... } }
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { templateId, sections, context } = body as {
      templateId?: string;
      sections?: string[];
      context?: Record<string, unknown>;
    };

    if (!templateId) {
      return NextResponse.json({ error: "templateId is required" }, { status: 400 });
    }
    if (!sections || sections.length === 0) {
      return NextResponse.json({ error: "sections array is required" }, { status: 400 });
    }

    const reportContext = {
      clientName: (context?.clientName as string) || "",
      dealerName: (context?.dealerName as string) || undefined,
      productName: (context?.productName as string) || undefined,
      dateRange: context?.dateRange as { start: string; end: string } | undefined,
      customNotes: (context?.customNotes as string) || undefined,
      repoPath: (context?.repoPath as string) || undefined,
      userId: user.id,
      userRole: user.role,
    };

    const report = await generateReport(templateId, sections, reportContext);

    return NextResponse.json({
      reportId: report.reportId,
      markdown: report.markdown,
      html: report.html,
      generatedAt: report.generatedAt,
      sectionsIncluded: report.sectionsIncluded,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to generate report", detail: (err as Error).message },
      { status: 500 },
    );
  }
}
