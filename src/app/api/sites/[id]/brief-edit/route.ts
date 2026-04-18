/**
 * POST /api/sites/[id]/brief-edit — prompt-to-brief edit.
 *
 * Body: { instruction: string }
 *
 * Auth: JWT + role >= sales (all team roles can edit).
 *
 * Responses:
 *   200  { edit_id, patch, renderedBrief, explanation }  — proposal ready
 *   400  { error }                                       — missing instruction
 *   401  { error }                                       — unauthenticated
 *   403  { error }                                       — role below sales
 *   404  { error }                                       — project not found
 *   422  { error, reason: "patch_blocked", blockedPaths } — guardrail rejection
 *   422  { error, reason: "brief_invalid" | "bad_ai_output" } — AI error
 *   502  { error, reason: "ai_unavailable" }             — model offline
 *
 * The patch is NOT applied to the saved brief here — this route only
 * stages the proposal. The PATCH handler at brief-edit/[editId]/route.ts
 * records the accept/reject decision. The existing /api/sites/[id]
 * PATCH is the only path that actually mutates apex_site_projects.brief.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, hasRole } from "@/lib/auth";
import { getSiteProject } from "@/lib/sites";
import {
  generateBriefEdit,
  BriefEditValidationError,
  BriefEditAIUnavailableError,
} from "@/lib/brief-edit";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasRole(user.role, "sales")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await context.params;

  let body: { instruction?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const instruction =
    typeof body.instruction === "string" ? body.instruction.trim() : "";
  if (!instruction) {
    return NextResponse.json(
      { error: "instruction required" },
      { status: 400 },
    );
  }

  const project = await getSiteProject(id);
  if (!project) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  try {
    const result = await generateBriefEdit({
      projectId: id,
      currentBrief: project.brief,
      instruction,
      userId: user.id,
      userRole: user.role,
    });
    return NextResponse.json({
      edit_id: result.editId,
      patch: result.patch,
      renderedBrief: result.renderedBrief,
      explanation: result.explanation,
    });
  } catch (err) {
    if (err instanceof BriefEditAIUnavailableError) {
      return NextResponse.json(
        { error: "AI edit service unavailable", reason: "ai_unavailable" },
        { status: 502 },
      );
    }
    if (err instanceof BriefEditValidationError) {
      if (err.reason === "patch_blocked") {
        return NextResponse.json(
          {
            error: err.message,
            reason: "patch_blocked",
            blockedPaths: (err.details.blockedPaths as string[]) ?? [],
          },
          { status: 422 },
        );
      }
      return NextResponse.json(
        { error: err.message, reason: err.reason },
        { status: 422 },
      );
    }
    console.error("[sites/id/brief-edit]", (err as Error).message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
