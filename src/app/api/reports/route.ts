import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import {
  getTemplates,
  generateReport,
  getReportHistory,
  saveAsTemplate,
  renderReportHtml,
  cleanAiArtifacts,
} from "@/lib/report-templates";
import { generateCustomReport } from "@/lib/claude-report-generator";
import { sanitizeForLog } from "@/lib/log-sanitize";

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
    console.error("[reports]", sanitizeForLog((err as Error).message));
    return NextResponse.json(
      { error: "Internal server error" },
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

    // Save as template action
    if (body.action === "save_as_template") {
      const template = await saveAsTemplate(
        body.name || "Custom Template",
        body.description || "",
        body.category || "client",
        sections,
        user.id,
        user.role,
      );
      return NextResponse.json({ template: { id: template.id, name: template.name } }, { status: 201 });
    }

    // Custom AI-generated report when using "Create Your Own" with a prompt
    const reportDescription = (context?.reportDescription as string) || "";
    if (templateId === "custom" && reportDescription.length > 10) {
      try {
        const aiResult = await generateCustomReport({
          prompt: reportDescription,
          clientName: (context?.clientName as string) || "Client",
          productContext: (context?.customNotes as string) || undefined,
          sections: sections,
          userId: user.id,
          userRole: user.role,
        });

        // Combine AI content with any selected template sections
        const report = await generateReport(templateId, sections, {
          clientName: (context?.clientName as string) || "",
          reportDescription: aiResult.content,
          customNotes: (context?.customNotes as string) || undefined,
          userId: user.id,
          userRole: user.role,
        });

        return NextResponse.json({
          reportId: report.reportId,
          markdown: report.markdown,
          html: report.html,
          generatedAt: report.generatedAt,
          sectionsIncluded: report.sectionsIncluded,
          ai: {
            tokensUsed: aiResult.tokensUsed,
            latencyMs: aiResult.latencyMs,
            model: aiResult.model,
            cached: aiResult.cached,
          },
        });
      } catch (err) {
        // AI failed — fall through to template-only generation
        console.warn("[reports] Claude generation failed, using template-only:", sanitizeForLog((err as Error).message));
      }
    }

    const reportContext = {
      clientName: (context?.clientName as string) || "",
      dealerName: (context?.dealerName as string) || undefined,
      productName: (context?.productName as string) || undefined,
      dateRange: context?.dateRange as { start: string; end: string } | undefined,
      customNotes: (context?.customNotes as string) || undefined,
      reportDescription: (context?.reportDescription as string) || undefined,
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
    console.error("[reports/generate]", sanitizeForLog((err as Error).message));
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
