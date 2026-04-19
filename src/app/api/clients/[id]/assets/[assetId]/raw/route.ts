/**
 * /api/clients/[id]/assets/[assetId]/raw — serve the raw bytes of a
 * client asset.
 *
 * Capability: `clients.view`. Byte-serving is the whole point of the
 * library — we trust any user who can see the client record to see its
 * assets.
 *
 * This resolves the canonical URL we store on `instinct_client_assets.url`.
 * The iframe preview + downstream site repos both fetch here to materialise
 * the image.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAssetById, loadAssetBlob } from "@/lib/client-assets";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string; assetId: string }> },
) {
  const auth = await requireCapability(req, "clients.view");
  if (!auth.ok) return auth.response;
  const { id: clientSlug, assetId } = await context.params;
  const asset = await getAssetById(assetId);
  if (!asset || asset.clientSlug !== clientSlug) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const blob = await loadAssetBlob(assetId);
  if (!blob) {
    return NextResponse.json({ error: "blob missing" }, { status: 410 });
  }
  const buf = Buffer.from(blob.contentBase64, "base64");
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": asset.mime,
      "Content-Length": String(buf.byteLength),
      "Cache-Control": "private, max-age=300",
    },
  });
}
