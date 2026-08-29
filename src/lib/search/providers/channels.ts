/**
 * Channels provider — searches the user's Microsoft Teams channels.
 *
 * Stage 1 matches channel name/description across top teams; stage 2, with a
 * query and remaining slots, scans recent messages in channels we have not
 * matched yet.
 *
 * WHY IT IS PARALLEL AND CAPPED
 *
 * Both stages used to await one Graph call at a time: 8 teams in sequence, then
 * up to 160 channels in sequence. Measured 2026-08-29 in production that ran at
 * a p95 of 22,136ms and a max of 129,458ms against the 6,000ms fan-out budget.
 * At roughly 130ms per Graph round trip, 160 sequential calls IS 21 seconds;
 * the number was not mysterious, it was arithmetic.
 *
 * The user never waited that long, because the budget abandoned the provider at
 * 6s. What they got instead was worse: an empty Teams result reported as though
 * Teams had been searched and held nothing.
 *
 * So the scan is now bounded and concurrent. A BOUNDED SCAN THAT FINISHES BEATS
 * AN UNBOUNDED ONE THAT GETS ABANDONED, which is the whole trade: the old code
 * could in principle reach channel 160 and in practice reached none of them.
 */

import { getValidToken } from "@/lib/microsoft-graph";
import {
  listJoinedTeams,
  listTeamChannels,
  listChannelMessages,
} from "@/lib/ms-graph-teams";
import type { SearchResult } from "../runSearch";
import type { RunSearchContext, SearchProvider } from "./types";
import { matches, buildSnippet, mapWithConcurrency } from "./util";

/** Teams whose channel lists are read. Unchanged; they now run concurrently. */
const MAX_TEAMS = 8;

/**
 * Channels whose recent messages are scanned in stage 2.
 *
 * Was effectively 160 (8 teams x 20 channels) and sequential, which could not
 * finish inside the 6,000ms budget. 48 at a concurrency of 8 is six waves,
 * roughly 800ms of Graph time, which does.
 */
const MAX_CHANNELS_SCANNED = 48;

/** In flight at once. Bounded so Graph does not answer 429 and cost us the
 *  time the concurrency saved. */
const MESSAGE_SCAN_CONCURRENCY = 8;

async function search(
  query: string,
  perTypeLimit: number,
  ctx: RunSearchContext,
): Promise<SearchResult[]> {
  const q = query;
  const token = await getValidToken(ctx.userId);
  if (!token) return [];
  const teamsRes = await listJoinedTeams(token.accessToken, 10, ctx.userId);
  if (!teamsRes.ok) return [];
  const out: SearchResult[] = [];
  const channelTriples: Array<{
    teamId: string;
    teamName: string;
    channel: {
      id: string;
      displayName: string;
      description?: string;
      webUrl?: string;
    };
  }> = [];
  /* Stage 1: every team's channel list at once. Eight calls, one wait. */
  const teams = teamsRes.teams.slice(0, MAX_TEAMS);
  const channelLists = await mapWithConcurrency(teams, MAX_TEAMS, (team) =>
    listTeamChannels(token.accessToken, team.id, 20, ctx.userId),
  );

  for (let i = 0; i < teams.length; i++) {
    const team = teams[i]!;
    const chRes = channelLists[i]!;
    if (!chRes.ok) continue;
    for (const ch of chRes.channels) {
      channelTriples.push({
        teamId: team.id,
        teamName: team.displayName,
        channel: ch,
      });
      if (
        matches(ch.displayName, q) ||
        matches(ch.description || "", q) ||
        matches(team.displayName, q)
      ) {
        out.push({
          type: "channel",
          id: `${team.id}:${ch.id}`,
          title: `${team.displayName} · ${ch.displayName}`,
          snippet: ch.description || "",
          timestamp: "",
          url: `/messages?team=${encodeURIComponent(team.id)}&channel=${encodeURIComponent(ch.id)}`,
        });
        if (out.length >= perTypeLimit) return out;
      }
    }
  }
  if (q && out.length < perTypeLimit) {
    const seen = new Set(out.map((r) => r.id));
    /* Capped BEFORE fetching. The old loop could queue 160 message reads and
       the budget would abandon every one of them, so the cap is not a
       reduction in what the user gets: it is the difference between some
       results and none. */
    const candidates = channelTriples
      .filter((t) => !seen.has(`${t.teamId}:${t.channel.id}`))
      .slice(0, MAX_CHANNELS_SCANNED);

    const scans = await mapWithConcurrency(candidates, MESSAGE_SCAN_CONCURRENCY, (t) =>
      listChannelMessages(token.accessToken, t.teamId, t.channel.id, 20, ctx.userId),
    );

    /* Walked in input order, not completion order, so the same search returns
       the same ranking every time. */
    for (let i = 0; i < candidates.length && out.length < perTypeLimit; i++) {
      const t = candidates[i]!;
      const msgs = scans[i]!;
      if (!msgs.ok) continue;
      const hit = msgs.messages.find((m) => matches(m.bodyText || "", q));
      if (!hit) continue;
      out.push({
        type: "channel",
        id: `${t.teamId}:${t.channel.id}`,
        title: `${t.teamName} · ${t.channel.displayName}`,
        snippet: buildSnippet(hit.bodyText || "", q),
        timestamp: hit.createdDateTime,
        url: `/messages?team=${encodeURIComponent(t.teamId)}&channel=${encodeURIComponent(t.channel.id)}`,
      });
    }
  }
  return out;
}

export const channelsProvider: SearchProvider = {
  type: "channel",
  name: "Microsoft Teams channels",
  countKey: "channels",
  isEnabled: () => true,
  search,
};
