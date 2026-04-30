/**
 * GET /api/qr/[id]/svg — render the QR SVG for an existing code on demand.
 *
 * The /qr UI shows the SVG inline only for a code the user just
 * created. Re-rendering it for older codes is a one-line server call
 * — far simpler than dragging the encoder into the client bundle.
 *
 * Auth-gated. Returns the raw SVG string with `Content-Type:
 * image/svg+xml` so callers can `<img src=...>` it directly OR pull
 * the bytes for inline render. Same redirect URL the original create
 * endpoint encoded.
 */
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getCodeById } from "@/lib/qr/codes";
import { renderQrSvg } from "@/lib/qr/svg";
import { resolvePublicOrigin } from "@/lib/qr/origin";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;
  const code = await getCodeById(id);
  if (!code) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const fullRedirectUrl = `${resolvePublicOrigin(req)}/q/${code.slug}`;

  const url = new URL(req.url);
  const sizeParam = url.searchParams.get("size");
  const size = sizeParam ? Math.min(Math.max(parseInt(sizeParam, 10), 96, 96), 1024) : 256;

  const svg = renderQrSvg(fullRedirectUrl, { size });

  return new NextResponse(svg, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "private, max-age=300",
    },
  });
}
