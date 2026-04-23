/**
 * /api/people/employees/[id] — GET / PUT / DELETE a single employee.
 *
 * Mirrors src/app/api/knowledge/[id]/route.ts — the canonical edit/delete
 * template (PUT + DELETE with analytics + audit log).
 *
 * Authorization:
 *   - GET  — any authenticated team member (list already authenticated).
 *   - PUT  — owner (created_by) OR capability `hr.employees.edit`.
 *   - DELETE — owner (created_by) OR capability `hr.employees.edit`.
 *
 * Every mutation writes to the hash-chained audit log (instinct_audit_log)
 * and fires a `hr.employee.*` analytics event. Failures in audit/analytics
 * are best-effort — the route never throws for bookkeeping issues.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  getEmployee,
  updateEmployee,
  deleteEmployee,
  type Employee,
} from "@/lib/people";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { hasCapability } from "@/lib/auth/require-capability";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const employee = await getEmployee(id);
  if (!employee) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ employee }, { status: 200 });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  try {
    const existing = await getEmployee(id);
    if (!existing) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    // Owner-or-capability authorization.
    const isOwner = existing.created_by === user.id;
    const canEdit = hasCapability(user, "hr.employees.edit");
    if (!isOwner && !canEdit) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as Partial<Employee>;
    if (body.full_name !== undefined && !body.full_name) {
      return NextResponse.json(
        { error: "full_name cannot be empty" },
        { status: 400 },
      );
    }

    const updated = await updateEmployee(id, body, user.id, user.role);
    if (!updated) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    // Audit log — before/after states, fire-and-forget on error.
    const meta = extractRequestMetadata(req);
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "hr.employee.updated",
      resourceType: "employee",
      resourceId: id,
      beforeState: existing,
      afterState: updated,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    }).catch((e) => console.warn("[audit]", (e as Error).message));

    return NextResponse.json({ ok: true, employee: updated }, { status: 200 });
  } catch (err) {
    console.error("[people/employees/id] PUT", (err as Error).message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  try {
    const existing = await getEmployee(id);
    if (!existing) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const isOwner = existing.created_by === user.id;
    const canEdit = hasCapability(user, "hr.employees.edit");
    if (!isOwner && !canEdit) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const ok = await deleteEmployee(id, user.id, user.role);
    if (!ok) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const meta = extractRequestMetadata(req);
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "hr.employee.deleted",
      resourceType: "employee",
      resourceId: id,
      beforeState: existing,
      afterState: null,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    }).catch((e) => console.warn("[audit]", (e as Error).message));

    return NextResponse.json({ ok: true, id }, { status: 200 });
  } catch (err) {
    console.error("[people/employees/id] DELETE", (err as Error).message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
