import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getFeatureRequests, submitFeatureRequest, type FeaturePriority } from "@/lib/feature-requests";
import { trackEvent } from "@/lib/analytics";

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status") || undefined;
  const product = req.nextUrl.searchParams.get("target_product") || undefined;

  const features = await getFeatureRequests(
    status as Parameters<typeof getFeatureRequests>[0],
    product,
  );

  trackEvent("system.page_viewed", "anonymous", "unknown", { page: "features_list" });
  return NextResponse.json({ features });
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { title, description, target_product, priority } = body;

  if (!title || !description) {
    return NextResponse.json({ error: "title and description are required" }, { status: 400 });
  }

  const feature = await submitFeatureRequest(
    title,
    description,
    user.id,
    target_product,
    priority as FeaturePriority,
  );

  return NextResponse.json({ feature }, { status: 201 });
}
