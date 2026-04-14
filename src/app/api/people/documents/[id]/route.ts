/**
 * /api/people/documents/[id] — get / recategorize / delete a single doc.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  getHrDocument,
  recategorizeDocument,
  linkDocumentToEmployee,
  unlinkDocumentFromEmployee,
  deleteHrDocument,
  HR_CATEGORIES,
  type HrCategory,
} from "@/lib/hr-documents";

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const doc = await getHrDocument(id);
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ document: doc });
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const body = await req.json().catch(() => ({}));
  const newCategory = body.category as HrCategory | undefined;
  const hasEmployeeId = "employee_id" in body;
  const employeeId = body.employee_id as string | null | undefined;

  // At least one field must be provided
  if (!newCategory && !hasEmployeeId) {
    return NextResponse.json({ error: "provide category and/or employee_id" }, { status: 400 });
  }

  // Validate category if provided
  if (newCategory && !(HR_CATEGORIES as readonly string[]).includes(newCategory)) {
    return NextResponse.json({ error: `category must be one of: ${HR_CATEGORIES.join(", ")}` }, { status: 400 });
  }

  let doc = null;

  // Handle category change
  if (newCategory) {
    doc = await recategorizeDocument(id, newCategory, user.id, user.role);
    if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Handle employee link/unlink
  if (hasEmployeeId) {
    if (employeeId === null) {
      doc = await unlinkDocumentFromEmployee(id, user.id, user.role);
    } else if (typeof employeeId === "string" && employeeId.length > 0) {
      doc = await linkDocumentToEmployee(id, employeeId, user.id, user.role);
    }
    if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json({ document: doc });
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const ok = await deleteHrDocument(id, user.id, user.role);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
