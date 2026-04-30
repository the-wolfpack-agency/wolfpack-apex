/**
 * /api/qr — list and create QR codes.
 *
 * POST → create a new code; returns the code, an inline SVG render,
 * the short URL (/q/{slug}), and the absolute fullRedirectUrl using
 * NEXT_PUBLIC_BASE_URL when available.
 *
 * GET → list codes for the auth'd user (admins see all via listCodes
 * defaults; we don't filter by owner here, mirroring the team-wide
 * dashboards on /sites and /knowledge).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { createCode, listCodes, validateTargetUrl } from "@/lib/qr/codes";
import { renderQrSvg } from "@/lib/qr/svg";

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    targetUrl?: string;
    label?: string;
    utmCampaign?: string;
    expiresAt?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body?.targetUrl || typeof body.targetUrl !== "string") {
    return NextResponse.json({ error: "targetUrl is required" }, { status: 400 });
  }

  let parsedTarget: URL;
  try {
    parsedTarget = validateTargetUrl(body.targetUrl);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 },
    );
  }

  try {
    const code = await createCode({
      targetUrl: body.targetUrl,
      label: body.label ?? null,
      utmCampaign: body.utmCampaign ?? null,
      expiresAt: body.expiresAt ?? null,
      userId: user.id,
      userRole: user.role,
    });

    const shortUrl = `/q/${code.slug}`;
    const base = process.env.NEXT_PUBLIC_BASE_URL?.replace(/\/+$/, "") ?? "";
    const fullRedirectUrl = `${base}${shortUrl}`;
    const qrSvg = renderQrSvg(fullRedirectUrl || `https://${parsedTarget.host}${shortUrl}`);

    trackEvent("assistant.qr_code_created", user.id, user.role, {
      slug: code.slug,
      has_utm: Boolean(body.utmCampaign),
      has_expiry: Boolean(body.expiresAt),
      target_host: parsedTarget.host,
    });

    return NextResponse.json({ code, qrSvg, shortUrl, fullRedirectUrl });
  } catch (err) {
    console.error("[api/qr] create failed:", (err as Error).message);
    return NextResponse.json(
      { error: "Failed to create QR code" },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const includeArchived = url.searchParams.get("includeArchived") === "true";
  const mineOnly = url.searchParams.get("mine") === "true";
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;

  const codes = await listCodes({
    limit: Number.isFinite(limit) ? limit : undefined,
    includeArchived,
    userId: mineOnly ? user.id : undefined,
  });

  return NextResponse.json({ codes });
}
