/**
 * GET /api/ms/teams/[teamId]/channels/[channelId]/messages — last N
 * messages in a Teams channel.
 *
 * Read-only for now. Posting to channels requires
 * ChannelMessage.Send + a different POST shape — separate scope of
 * work.
 *
 * Responses:
 *   200 { messages: ChannelMessage[] }
 *   200 { messages: [], scope_missing: true }     — needs ChannelMessage.Read.All
 *   200 { messages: [], connected: false }
 *   400 { error: "missing teamId or channelId" }
 *   401 { error: "Unauthorized" }
 *   500 { error: "Internal error" }
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getValidToken } from "@/lib/microsoft-graph";
import { listChannelMessages } from "@/lib/ms-graph-teams";

export async function GET(
  req: NextRequest,
  {
    params,
  }: { params: Promise<{ teamId: string; channelId: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { teamId, channelId } = await params;
  if (!teamId || !channelId) {
    return NextResponse.json(
      { error: "missing teamId or channelId" },
      { status: 400 },
    );
  }
  try {
    const url = new URL(req.url);
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw
      ? Math.max(1, Math.min(100, parseInt(limitRaw, 10) || 30))
      : 30;
    const token = await getValidToken(user.id);
    if (!token) {
      return NextResponse.json({ messages: [], connected: false });
    }
    const result = await listChannelMessages(
      token.accessToken,
      teamId,
      channelId,
      limit,
      user.id,
    );
    if (!result.ok) {
      return NextResponse.json({ messages: [], scope_missing: true });
    }
    return NextResponse.json({ messages: result.messages });
  } catch (err) {
    console.error(
      "[api/ms/teams/[teamId]/channels/[channelId]/messages] error:",
      (err as Error).message,
    );
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
