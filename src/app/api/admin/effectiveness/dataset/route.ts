/**
 * GET /api/admin/effectiveness/dataset - the labeled governance corpus for the
 * caller's workspace (eval / fine-tune seed). Decision-level: the platform's own
 * verdicts as labels + safe structural features; never the raw diff or payload.
 *
 *   ?format=jsonl -> text/plain, one example per line (fine-tune tooling format)
 *   default       -> application/json { export }
 *
 * Capability: settings.manage_team. Read-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { buildDataset, liveDatasetDeps, toJsonl } from "@/lib/effectiveness/dataset";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const data = await buildDataset(auth.user.workspaceId ?? "default", liveDatasetDeps());

  if (req.nextUrl.searchParams.get("format") === "jsonl") {
    return new NextResponse(toJsonl(data.examples), {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'attachment; filename="effectiveness-dataset.jsonl"',
      },
    });
  }
  return NextResponse.json({ export: data });
}
