/**
 * /api/people/employees — list + create employees.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { listEmployees, createEmployee } from "@/lib/people";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const employees = await listEmployees();
  return NextResponse.json({ employees });
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body.full_name) return NextResponse.json({ error: "full_name required" }, { status: 400 });
  try {
    const employee = await createEmployee(body, user.id, user.role);
    const meta = extractRequestMetadata(req);
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "hr.employee.created",
      resourceType: "employee",
      resourceId: (employee as { id?: string } | null)?.id,
      afterState: employee,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    }).catch((e) => console.warn("[audit]", (e as Error).message));
    return NextResponse.json({ employee }, { status: 201 });
  } catch (err) {
    console.error("[people/employees]", (err as Error).message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
