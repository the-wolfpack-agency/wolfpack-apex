import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { downloadDocument, getDocuments } from "@/lib/doc-generator";

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

    return NextResponse.json({ document: doc });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to get document", detail: (err as Error).message },
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
    return NextResponse.json(
      { error: "Failed to download document", detail: (err as Error).message },
      { status: 500 },
    );
  }
}
