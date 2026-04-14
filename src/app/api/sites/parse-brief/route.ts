/**
 * /api/sites/parse-brief — drag-and-drop brief parser.
 *
 * Accepts either:
 *   - JSON body { rawInput: string, clientSlug: string }
 *   - multipart form with "file" + "clientSlug"
 *
 * Returns { brief, source, tokensUsed, confidence }. The user reviews
 * before saving — this endpoint never persists.
 *
 * Auth required. Every parse attempt is tracked (success OR failure)
 * inside parseBrief() so the brain learns input shapes vs. AI fallback.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { parseBrief } from "@/lib/brief-parser";
import { trackEvent } from "@/lib/analytics";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB cap

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const contentType = req.headers.get("content-type") ?? "";
  let rawInput: string;
  let clientSlug: string;

  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      clientSlug = String(form.get("clientSlug") ?? "");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "file required" }, { status: 400 });
      }
      if (file.size > MAX_BYTES) {
        return NextResponse.json({ error: `file too large (${MAX_BYTES} bytes max)` }, { status: 413 });
      }
      rawInput = await file.text();
      trackEvent("site.dropzone_used", user.id, user.role, {
        filename: file.name,
        size_bytes: file.size,
        client_slug: clientSlug,
      });
    } else {
      const body = await req.json();
      rawInput = String(body.rawInput ?? "");
      clientSlug = String(body.clientSlug ?? "");
    }
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  if (!rawInput || !clientSlug) {
    return NextResponse.json({ error: "rawInput and clientSlug required" }, { status: 400 });
  }
  if (!/^[a-z][a-z0-9-]{1,38}$/.test(clientSlug)) {
    return NextResponse.json({ error: "clientSlug must be a lowercase slug" }, { status: 400 });
  }

  try {
    const result = await parseBrief(rawInput, clientSlug, user.id, user.role);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[sites/parse-brief]", (err as Error).message);
    return NextResponse.json({ error: "Failed to parse brief" }, { status: 422 });
  }
}
