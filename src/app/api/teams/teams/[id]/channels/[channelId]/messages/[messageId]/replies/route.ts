/**
 * POST /api/teams/teams/[id]/channels/[channelId]/messages/[messageId]/replies
 *
 * Forbidden for Tier 2 — requires `ChannelMessage.Send` which is NOT in the
 * Tier 1/2 scope set. Always returns 501 Not Implemented with an
 * instruction. Kept as a route (rather than a 404) so callers can discover
 * the feature gap without probing OAuth.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; channelId: string; messageId: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = await ctx.params;
  trackEvent("system.capability_denied", user.id, user.role, {
    endpoint: "teams.channel.reply",
    reason: "scope_not_granted",
    required_scope: "ChannelMessage.Send",
    team_id: params.id ?? "",
    channel_id: params.channelId ?? "",
    message_id: params.messageId ?? "",
  });

  return NextResponse.json(
    {
      error: "not_implemented",
      code: "scope_not_granted",
      scope: "ChannelMessage.Send",
      detail:
        "Replying to Teams channel messages requires the ChannelMessage.Send scope, which is not enabled in Tier 1/2. Use the Teams app to reply.",
    },
    { status: 501 },
  );
}
