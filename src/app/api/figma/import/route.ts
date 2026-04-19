/**
 * /api/figma/import — Figma-file importer endpoint.
 *
 * Designer pastes a Figma file URL into the FigmaImporter panel. The
 * UI POSTs here. This route authenticates, role-gates, then hands off
 * to `importFromFigmaUrl` which owns the token handling, timeout, and
 * transformation to a SiteBrief suggestion. Analytics fires from the
 * library so any caller (future CLI ingest, nightly re-import) feeds
 * the same learning loop.
 *
 * Status code mapping:
 *   200 — ok OR soft-empty (UI reads `ok` + `reason` to decide).
 *   400 — invalid_url (can't parse).
 *   401 — no Bearer token.
 *   403 — role < sales OR Figma rejected token as unauthorized.
 *   404 — Figma file not found / not accessible to the token.
 *   429 — Figma rate-limited us; Retry-After surfaced in header.
 *   502 — generic Figma fetch failure.
 *   503 — FIGMA_ACCESS_TOKEN env var not set.
 *   504 — upstream fetch timeout.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, hasRole } from "@/lib/auth";
import { importFromFigmaUrl } from "@/lib/figma-import";

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasRole(user.role, "sales")) {
    return NextResponse.json(
      { error: "insufficient role", reason: "role_insufficient" },
      { status: 403 },
    );
  }

  let body: { url?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const url = typeof body.url === "string" ? body.url : "";
  if (!url) {
    return NextResponse.json({ error: "url required" }, { status: 400 });
  }

  const result = await importFromFigmaUrl(
    { url },
    { user: { id: user.id, role: user.role } },
  );

  // Map typed reason → HTTP status. The body always carries the
  // structured FigmaImportResult so the UI can present a specific error
  // regardless of status (same contract as /api/brand/scrape).
  if (result.ok) {
    return NextResponse.json(result, { status: 200 });
  }
  switch (result.reason) {
    case "invalid_url":
      return NextResponse.json(result, { status: 400 });
    case "not_configured":
      return NextResponse.json(
        {
          ...result,
          error: "Figma import requires FIGMA_ACCESS_TOKEN env var",
        },
        { status: 503 },
      );
    case "unauthorized":
      return NextResponse.json(result, { status: 403 });
    case "file_not_found":
      return NextResponse.json(result, { status: 404 });
    case "rate_limited": {
      const headers: Record<string, string> = {};
      if (typeof result.retryAfterSeconds === "number") {
        headers["Retry-After"] = String(result.retryAfterSeconds);
      }
      return NextResponse.json(result, { status: 429, headers });
    }
    case "timeout":
      return NextResponse.json(result, { status: 504 });
    case "fetch_failed":
      return NextResponse.json(result, { status: 502 });
    case "empty_result":
      // Soft-failure: we got a response but nothing usable. 200 so the
      // UI can render the empty-state copy without a blocked HTTP code.
      return NextResponse.json(result, { status: 200 });
    default:
      return NextResponse.json(result, { status: 500 });
  }
}
