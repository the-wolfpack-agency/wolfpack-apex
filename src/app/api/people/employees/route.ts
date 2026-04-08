/**
 * /api/people/employees — list + create employees.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { listEmployees, createEmployee } from "@/lib/people";

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
    return NextResponse.json({ employee }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
