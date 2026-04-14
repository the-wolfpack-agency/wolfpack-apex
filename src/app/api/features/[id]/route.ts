import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, hasRole } from "@/lib/auth";
import { getFeatureRequests, updateFeatureStatus, type FeatureStatus } from "@/lib/feature-requests";
import { safeQuery } from "@/lib/db";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { rows } = await safeQuery(
    "SELECT * FROM apex_feature_requests WHERE id = $1",
    [id],
  );

  if (rows.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ feature: rows[0] });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { status } = body;

  if (!status) {
    return NextResponse.json({ error: "status is required" }, { status: 400 });
  }

  // Only cto/dev can approve/reject
  if ((status === "approved" || status === "rejected") && !hasRole(user.role, "dev")) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const feature = await updateFeatureStatus(id, status as FeatureStatus, user.id);
  if (!feature) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ feature });
}
