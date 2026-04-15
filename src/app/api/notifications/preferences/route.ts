/**
 * Notification preferences endpoints.
 *   GET  /api/notifications/preferences — caller's prefs.
 *   PUT  /api/notifications/preferences — update, validated, emits analytics.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import {
  getPreferences,
  updatePreferences,
  type UpdatePreferencesInput,
} from "@/lib/notifications/in-app";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const prefs = await getPreferences(user.id);
  return NextResponse.json({ preferences: prefs });
}

export async function PUT(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const input: UpdatePreferencesInput = {};
  if ("in_app" in body) input.in_app = Boolean(body.in_app);
  if ("email_digest" in body) input.email_digest = body.email_digest as never;
  if ("quiet_hours_start" in body) {
    input.quiet_hours_start =
      body.quiet_hours_start === null ? null : String(body.quiet_hours_start);
  }
  if ("quiet_hours_end" in body) {
    input.quiet_hours_end =
      body.quiet_hours_end === null ? null : String(body.quiet_hours_end);
  }
  if ("timezone" in body) input.timezone = String(body.timezone);
  if ("category_overrides" in body) {
    input.category_overrides = body.category_overrides as never;
  }

  try {
    const { preferences, changes } = await updatePreferences(user.id, input);
    trackEvent("system.notification_preferences_updated", user.id, "system", {
      user_id: user.id,
      changes: changes.join(","),
    });
    return NextResponse.json({ preferences, changes });
  } catch (err) {
    const msg = (err as Error).message;
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
