import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { effectiveCapabilitiesFor } from "@/lib/auth/require-capability";
import {
  updateFeatureStatus,
  updateFeatureRequest,
  deleteFeatureRequest,
  getFeatureRequest,
  type FeatureStatus,
  type FeaturePriority,
  type FeatureUpdate,
} from "@/lib/feature-requests";
import { safeQuery } from "@/lib/db";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { tripleWriteEvent } from "@/lib/triple-write";

/**
 * Owner-or-admin gate — a feature can be edited/deleted by the person
 * who submitted it OR a CTO/CEO. HR/sales/dev can't stomp each other's
 * submissions. Keeps the /features board collaborative without opening
 * a grief vector.
 */
function isAdminRole(role: string): boolean {
  return role === "cto" || role === "ceo";
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { rows } = await safeQuery(
    "SELECT * FROM instinct_feature_requests WHERE id = $1",
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

  // Approve/reject requires features.approve capability.
  if (status === "approved" || status === "rejected") {
    const { capabilities } = await effectiveCapabilitiesFor(user);
    if (!capabilities.has("features.approve")) {
      return NextResponse.json(
        { error: "forbidden", capability: "features.approve" },
        { status: 403 },
      );
    }
  }

  const feature = await updateFeatureStatus(id, status as FeatureStatus, user.id);
  if (!feature) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ feature });
}

/**
 * PUT /api/features/[id] — edit an existing feature request.
 *
 * Body: { title?, description?, priority?, target_product? }
 *
 * Auth: submitter OR admin (cto/ceo). A 403 fires even for authenticated
 * users who aren't the owner so the `/features` board can't be used to
 * rewrite another team member's submission. Audit log + analytics event
 * + fire-and-forget triple-write fanout are non-negotiable — this is
 * what lets the learning loop see churn on feature descriptions.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const existing = await getFeatureRequest(id);
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (existing.submitted_by !== user.id && !isAdminRole(user.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json()) as {
    title?: unknown;
    description?: unknown;
    priority?: unknown;
    target_product?: unknown;
  };

  const updates: FeatureUpdate = {};
  if (typeof body.title === "string" && body.title.trim().length > 0) {
    updates.title = body.title.trim();
  }
  if (typeof body.description === "string" && body.description.trim().length > 0) {
    updates.description = body.description.trim();
  }
  if (
    typeof body.priority === "string" &&
    ["low", "medium", "high", "critical"].includes(body.priority)
  ) {
    updates.priority = body.priority as FeaturePriority;
  }
  if (body.target_product === null || typeof body.target_product === "string") {
    updates.target_product = body.target_product as string | null;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: "at least one field is required" },
      { status: 400 },
    );
  }

  const feature = await updateFeatureRequest(id, updates, user.id);
  if (!feature) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "features.edited",
      resourceType: "feature_request",
      resourceId: id,
      beforeState: {
        title: existing.title,
        description: existing.description,
        priority: existing.priority,
        target_product: existing.target_product,
      },
      afterState: {
        title: feature.title,
        description: feature.description,
        priority: feature.priority,
        target_product: feature.target_product,
      },
      ...extractRequestMetadata(req),
    });
  } catch (err) {
    console.error("[features PUT audit]", (err as Error).message);
  }

  // Re-triple-write so vector/graph stay in sync with the corrected row.
  // Fire-and-forget: the primary DB write above is the source of truth.
  void tripleWriteEvent({
    event_type: "features.edited",
    user_id: user.id,
    user_role: user.role,
    metadata: {
      feature_id: id,
      title: feature.title,
      description: feature.description,
    },
  });

  return NextResponse.json({ ok: true, feature }, { status: 200 });
}

/**
 * DELETE /api/features/[id] — remove a feature request.
 *
 * Auth: submitter OR admin (cto/ceo). Same ownership gate as PUT. Fires
 * `features.deleted` and records the before-state in the audit log so
 * compliance can reconstruct what the board looked like. Hard delete
 * for now — table has no `deleted_at`.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const existing = await getFeatureRequest(id);
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (existing.submitted_by !== user.id && !isAdminRole(user.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const ok = await deleteFeatureRequest(id, user.id);
  if (!ok) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "features.deleted",
      resourceType: "feature_request",
      resourceId: id,
      beforeState: {
        title: existing.title,
        description: existing.description,
        priority: existing.priority,
        status: existing.status,
        submitted_by: existing.submitted_by,
      },
      ...extractRequestMetadata(req),
    });
  } catch (err) {
    console.error("[features DELETE audit]", (err as Error).message);
  }

  trackEvent("features.deleted", user.id, user.role, { feature_id: id });

  return NextResponse.json({ ok: true, id }, { status: 200 });
}
