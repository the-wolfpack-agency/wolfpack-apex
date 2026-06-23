/**
 * POST /api/admin/provision-health-bot
 *
 * One-shot admin endpoint to provision the AgenticQA nightly
 * orchestrator's service-account principal. Returns a JWT for a
 * minimal-privilege bot user who holds ONLY admin.health.probe.
 *
 * Why an endpoint instead of a local CLI: production secrets
 * (INSTINCT_JWT_SECRET) are correctly blanked when pulled to
 * dev. The endpoint runs inside the live Vercel function where
 * those env vars are present.
 *
 * Auth: CEO/CTO only. Audit-logged.
 *
 * Side effects (idempotent — safe to re-run):
 *   1. Inserts or finds the bot row in instinct_team_members
 *      (email=agenticqa-bot@thewolfpack.agency, role=dev).
 *   2. Sets capability_overrides to grant ONLY admin.health.probe.
 *   3. Mints a 90-day JWT for the bot.
 *
 * Response (200 OK):
 *   { token, botUserId, expiresAt }
 *
 * Usage:
 *   curl -sS -X POST -H "Authorization: Bearer <CTO_JWT>" \
 *     https://wolfpack-instinct.vercel.app/api/admin/provision-health-bot \
 *     | jq -r .token | gh secret set INSTINCT_SERVICE_TOKEN \
 *     --repo nhomyk/AgenticQA
 */

import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { signToken } from "@/lib/crypto/sign";
import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

const BOT_EMAIL = "agenticqa-bot@thewolfpack.agency";
const BOT_NAME = "AgenticQA Health Bot";
const BOT_ROLE = "dev";
const PROBE_CAPABILITY = "admin.health.probe";
const TOKEN_TTL_DAYS = 90;

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "ceo" && user.role !== "cto") {
    return NextResponse.json({ error: "Forbidden (CEO/CTO only)" }, { status: 403 });
  }

  /* 1. Find-or-create the bot row. */
  let botId: string;
  const existing = await safeQuery<{ id: string }>(
    `SELECT id FROM instinct_team_members WHERE email = $1 LIMIT 1`,
    [BOT_EMAIL],
  );
  if (existing.rows.length > 0) {
    botId = existing.rows[0].id;
  } else {
    botId = randomUUID();
    /* Random password_hash → password login fails closed. Bot
     * authenticates via the JWT this endpoint returns, nothing else. */
    const pwHash = randomUUID() + randomUUID();
    await safeQuery(
      `INSERT INTO instinct_team_members
         (id, email, name, role, password_hash, is_active, created_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, NOW())`,
      [botId, BOT_EMAIL, BOT_NAME, BOT_ROLE, pwHash],
    );
  }

  /* 2. Grant the probe capability + clear any prior grants on this
   * row so re-running narrows back to minimum. */
  const overrides = {
    grants: [PROBE_CAPABILITY],
    revokes: [],
    expires: {},
  };
  await safeQuery(
    `UPDATE instinct_team_members
        SET capability_overrides = $2::jsonb
      WHERE id = $1`,
    [botId, JSON.stringify(overrides)],
  );

  /* 3. Mint the JWT. signToken reads INSTINCT_JWT_SECRET from env. */
  const ttlSec = TOKEN_TTL_DAYS * 24 * 60 * 60;
  const token = signToken(
    {
      userId: botId,
      email: BOT_EMAIL,
      name: BOT_NAME,
      role: BOT_ROLE,
      workspaceId: "default",
    },
    { ttlSeconds: ttlSec },
  );

  trackEvent("system.audit_log_viewed", user.id, user.role, {
    view: "provision.health_bot",
    bot_user_id: botId,
  });

  /* Provisioning a service principal grants a capability and mints a
     long-lived credential, a security-relevant admin action. Hash-chain
     it: who provisioned, which bot, which capability. Never record the
     token material. Best-effort; an audit failure must not break the
     provisioning response. */
  try {
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "admin.service_principal_provisioned",
      resourceType: "team_member",
      resourceId: botId,
      afterState: {
        bot_email: BOT_EMAIL,
        capability_granted: PROBE_CAPABILITY,
        token_ttl_days: TOKEN_TTL_DAYS,
      },
      ...extractRequestMetadata(req),
    });
  } catch (err) {
    console.error("[provision-health-bot audit]", (err as Error).message);
  }

  return NextResponse.json({
    token,
    botUserId: botId,
    expiresAt: new Date(Date.now() + ttlSec * 1000).toISOString(),
    note: "Drop this into GitHub Actions secret INSTINCT_SERVICE_TOKEN. Token has only admin.health.probe.",
  });
}
