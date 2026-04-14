import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { downloadDocument, getDocuments } from "@/lib/doc-generator";
import { trackEvent } from "@/lib/analytics";

/**
 * GET /api/docs/[id] — Get a single document.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const docs = await getDocuments();
    const doc = docs.find((d) => d.id === id);

    if (!doc) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    // IDOR check: only the document owner or cto/ceo can access
    if (doc.generated_by !== user.id && user.role !== "cto" && user.role !== "ceo") {
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
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
