/**
 * GET /api/teams/teams/[id]/channels/[channelId]/messages
 *
 * Cache-backed read path. Supports cursor pagination, FTS-over-subject+body
 * via ?search, a ?since ISO filter, and a ?mentioned=<userId> filter for
 * surfacing channel messages where the user was @-mentioned.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  getCachedChannelById,
  getCachedTeamById,
  listCachedChannelMessages,
} from "@/lib/integrations/microsoft-channel-messages";

export async function GET(
  req: NextRequest,
  ctx: { params: { id: string; channelId: string } },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const teamId = ctx.params?.id;
  const channelId = ctx.params?.channelId;
  if (!teamId || !channelId) {
    return NextResponse.json(
      { error: "invalid_input", detail: "missing_id" },
      { status: 400 },
    );
  }

  const team = await getCachedTeamById(user.id, teamId);
  if (!team) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const channel = await getCachedChannelById(user.id, channelId);
  if (!channel || channel.teamId !== teamId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const limitStr = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  const search = url.searchParams.get("search");
  const since = url.searchParams.get("since");
  const mentioned = url.searchParams.get("mentioned");

  const { messages, nextCursor } = await listCachedChannelMessages(
    user.id,
    channelId,
    {
      limit: limitStr ? parseInt(limitStr, 10) : undefined,
      cursor: cursor || undefined,
      search: search || undefined,
      since: since || undefined,
      mentionedUserId: mentioned === "me" ? user.id : mentioned || undefined,
    },
  );

  return NextResponse.json({ team, channel, messages, nextCursor });
}
