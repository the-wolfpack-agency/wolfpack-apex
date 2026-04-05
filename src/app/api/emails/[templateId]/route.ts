import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { customizeTemplate } from "@/lib/email-generator";

/**
 * POST /api/emails/[templateId] — Customize a specific template with variables.
 *
 * Body: { variables: Record<string, string> }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ templateId: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const resolvedParams = await params;
  const { templateId } = resolvedParams;

  trackEvent("system.page_viewed", user.id, user.role, {
    module: "emails",
    action: "customize",
    template: templateId,
  });

  try {
    const body = await req.json();
    const { variables } = body as { variables?: Record<string, string> };

    if (!variables || typeof variables !== "object") {
      return NextResponse.json(
        { error: "variables object is required" },
        { status: 400 },
      );
    }

    const draft = customizeTemplate(templateId, variables, user.id, user.role);
    return NextResponse.json({ draft, tokens_used: 0 });
  } catch (err) {
    const message = (err as Error).message;

    if (message.includes("Unknown template")) {
      return NextResponse.json({ error: message }, { status: 404 });
    }

    if (message.includes("Missing required")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }

    return NextResponse.json(
      { error: "Failed to customize template", detail: message },
      { status: 500 },
    );
  }
}
