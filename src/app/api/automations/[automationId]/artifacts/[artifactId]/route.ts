/**
 * GET /api/automations/[automationId]/artifacts/[artifactId]
 *
 * Streams the raw bytes of the stored artifact (eml / xlsx) so the
 * exception-queue UI's "Open artifact" link can hand the original
 * file back to a human reviewer.
 *
 * Auth: `automations.view` capability required.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAutomation } from "@/lib/automations/registry";
import { getArtifactBytes } from "@/lib/automations/queries";

export async function GET(
  req: NextRequest,
  ctx: {
    params: Promise<{ automationId: string; artifactId: string }>;
  },
) {
  const auth = await requireCapability(req, "automations.view");
  if (!auth.ok) return auth.response;

  const { automationId, artifactId } = await ctx.params;
  const automation = getAutomation(automationId);
  if (!automation) {
    return NextResponse.json({ error: "automation not found" }, { status: 404 });
  }

  const a = await getArtifactBytes({ artifactId });
  if (!a) {
    return NextResponse.json({ error: "artifact not found" }, { status: 404 });
  }

  // pg returns a Node Buffer; copy into a fresh Uint8Array so we hand
  // off an exact-sized BodyInit (the underlying Buffer's .buffer can be
  // a shared pool that includes neighbour bytes).
  const view = a.bytes;
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);

  return new NextResponse(copy, {
    status: 200,
    headers: {
      "Content-Type": a.mime || "application/octet-stream",
      "Content-Disposition": `attachment; filename="artifact-${artifactId}"`,
    },
  });
}
