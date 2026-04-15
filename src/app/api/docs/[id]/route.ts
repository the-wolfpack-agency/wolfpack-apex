import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { downloadDocument, getDocuments } from "@/lib/doc-generator";
import { trackEvent } from "@/lib/analytics";

/**
 * GET /api/docs/[id] — Get a single document.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "docs.view");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  try {
    const { id } = await params;
    const docs = await getDocuments();
    const doc = docs.find((d) => d.id === id);

    if (!doc) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    // IDOR check: only the document owner or a user with docs.edit
    // (workspace-level editing rights) can access someone else's doc.
    if (doc.generated_by !== user.id && !auth.capabilities.has("docs.edit")) {
      trackEvent("system.unauthorized_access_attempt", user.id, user.role, { resource: "doc", resource_id: id });
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    return NextResponse.json({ document: doc });
  } catch (err) {
    console.error("[docs/id]", (err as Error).message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/docs/[id] — Download (increment counter).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "docs.view");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  try {
    const { id } = await params;
    const doc = await downloadDocument(id, user.id);

    if (!doc) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    return NextResponse.json({ document: doc });
  } catch (err) {
    console.error("[docs/id/download]", (err as Error).message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
