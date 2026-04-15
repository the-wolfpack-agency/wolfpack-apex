import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { rateAnswer } from "@/lib/knowledge";

/**
 * POST /api/knowledge/[id]/rate — Rate a knowledge entry.
 *
 * Body: { rating: number } (1-5)
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "knowledge.rate");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  try {
    const { id } = await params;
    const body = await req.json();
    const { rating } = body as { rating?: number };

    if (typeof rating !== "number" || rating < 1 || rating > 5) {
      return NextResponse.json({ error: "rating must be 1-5" }, { status: 400 });
    }

    const success = await rateAnswer(id, rating, user.id);
    return NextResponse.json({ success, knowledge_id: id, rating });
  } catch (err) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
