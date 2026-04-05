import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { analyzeFeatureRequest } from "@/lib/feature-requests";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const analysis = await analyzeFeatureRequest(id);
  if (!analysis) {
    return NextResponse.json({ error: "Feature request not found" }, { status: 404 });
  }

  return NextResponse.json({ analysis });
}
