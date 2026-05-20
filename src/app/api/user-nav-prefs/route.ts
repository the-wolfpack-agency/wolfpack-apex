/**
 * /api/user-nav-prefs — per-user dashboard nav visibility preferences.
 *
 * GET  → { hiddenHrefs: string[] }
 * PUT  → body { hiddenHrefs: string[] } → upserts the row, returns
 *        the saved prefs.
 *
 * Both routes scope to the JWT's user.id. Validation against the
 * canonical NAV list is enforced in the lib so an invalid href
 * returns 400 with the offending value.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { getNavPrefs, setNavPrefs } from "@/lib/user-nav-prefs";
import { WriteQueryError } from "@/lib/db";
import { sanitizeForLog } from "@/lib/log-sanitize";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const prefs = await getNavPrefs(user.id);
  return NextResponse.json({
    hiddenHrefs: prefs.hiddenHrefs,
    updatedAt: prefs.updatedAt,
    isFirstTime: prefs.isFirstTime,
  });
}

export async function PUT(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { hiddenHrefs?: unknown };
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const saved = await setNavPrefs(
      user.id,
      Array.isArray(body.hiddenHrefs) ? (body.hiddenHrefs as unknown[]) as string[] : [],
    );
    trackEvent("user.nav_pref_updated", user.id, user.role, {
      hidden_count: saved.hiddenHrefs.length,
      /* trackEvent's metadata signature is scalar-only; serialize the
         hrefs as a comma-joined string so the learning loop still
         gets the per-href signal. */
      hidden_hrefs: saved.hiddenHrefs.join(","),
    });
    return NextResponse.json({
      hiddenHrefs: saved.hiddenHrefs,
      updatedAt: saved.updatedAt,
    });
  } catch (err) {
    if (err instanceof WriteQueryError) {
      console.error("[api/user-nav-prefs]", sanitizeForLog(err.message));
      return NextResponse.json(
        { error: "Failed to save preferences" },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 },
    );
  }
}
