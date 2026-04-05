import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import {
  getEmailTemplates,
  generateProposalEmail,
  generateFollowUpEmail,
  generateStatusUpdateEmail,
  generateOnboardingEmail,
} from "@/lib/email-generator";

/**
 * GET /api/emails — List all available email templates.
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  trackEvent("system.page_viewed", user.id, user.role, { module: "emails" });

  const templates = getEmailTemplates();
  return NextResponse.json({ templates });
}

/**
 * POST /api/emails — Generate an email from a template.
 *
 * Body: { templateId: string, variables: Record<string, string> }
 *
 * For convenience, also accepts shorthand bodies:
 *   { templateId: "proposal", clientName, productName, features[], pricing? }
 *   { templateId: "followup", clientName, meetingDate, actionItems[] }
 *   { templateId: "status_update", clientName, projectName, completedItems[], upcomingItems[] }
 *   { templateId: "onboarding", clientName, loginUrl, adminUrl }
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { templateId } = body as { templateId?: string };

    if (!templateId || typeof templateId !== "string") {
      return NextResponse.json({ error: "templateId is required" }, { status: 400 });
    }

    let draft;

    switch (templateId) {
      case "proposal": {
        const { clientName, productName, features, pricing } = body;
        if (!clientName || !productName || !features) {
          return NextResponse.json(
            { error: "proposal requires: clientName, productName, features (array)" },
            { status: 400 },
          );
        }
        draft = generateProposalEmail(
          clientName,
          productName,
          Array.isArray(features) ? features : [features],
          user.id,
          user.role,
          pricing,
        );
        break;
      }

      case "followup": {
        const { clientName, meetingDate, actionItems } = body;
        if (!clientName || !meetingDate || !actionItems) {
          return NextResponse.json(
            { error: "followup requires: clientName, meetingDate, actionItems (array)" },
            { status: 400 },
          );
        }
        draft = generateFollowUpEmail(
          clientName,
          meetingDate,
          Array.isArray(actionItems) ? actionItems : [actionItems],
          user.id,
          user.role,
        );
        break;
      }

      case "status_update": {
        const { clientName, projectName, completedItems, upcomingItems } = body;
        if (!clientName || !projectName || !completedItems || !upcomingItems) {
          return NextResponse.json(
            { error: "status_update requires: clientName, projectName, completedItems (array), upcomingItems (array)" },
            { status: 400 },
          );
        }
        draft = generateStatusUpdateEmail(
          clientName,
          projectName,
          Array.isArray(completedItems) ? completedItems : [completedItems],
          Array.isArray(upcomingItems) ? upcomingItems : [upcomingItems],
          user.id,
          user.role,
        );
        break;
      }

      case "onboarding": {
        const { clientName, loginUrl, adminUrl } = body;
        if (!clientName || !loginUrl || !adminUrl) {
          return NextResponse.json(
            { error: "onboarding requires: clientName, loginUrl, adminUrl" },
            { status: 400 },
          );
        }
        draft = generateOnboardingEmail(clientName, loginUrl, adminUrl, user.id, user.role);
        break;
      }

      default:
        return NextResponse.json(
          { error: `Unknown template: ${templateId}. Use GET /api/emails to list available templates.` },
          { status: 400 },
        );
    }

    return NextResponse.json({ draft, tokens_used: 0 });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to generate email", detail: (err as Error).message },
      { status: 500 },
    );
  }
}
