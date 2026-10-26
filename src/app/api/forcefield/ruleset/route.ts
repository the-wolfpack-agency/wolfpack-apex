/**
 * GET /api/forcefield/ruleset
 *
 * PUBLIC: serves the Forcefield detection ruleset (allowlisted agents, trap paths,
 * sensitive-path list, tool signatures) that every connected site fetches and
 * caches. This is the "update once, all sites follow" seam: change the ruleset
 * here and each site picks it up within its cache TTL, no per-site redeploy. The
 * payload is non-sensitive by design (it is detection rules, not secrets), so the
 * endpoint is intentionally unauthenticated and CDN-cacheable - sites on any
 * origin must be able to read it, and it must not depend on a session.
 *
 * Returns the bundled DEFAULT_RULESET, plus the live verifiedAgentRanges (vendor-
 * published crawler IP lists, see crawler-ranges.ts), plus (when FORCEFIELD_DISTRIBUTE_BLOCKS is
 * "on") the blockedFingerprints an admin has blocked from the board, so every
 * site turns those operators away pre-emptively. Flag-gated + fail-safe: any
 * error, or the flag off, serves an EMPTY block list rather than a wrong one.
 * An AUTOMATIC block on a generic fingerprint (default curl, a library, a
 * headless browser) is never served; only an admin may block those tool-wide
 * (see forcefield/autoblock-scope.ts).
 *
 * Responses: 200 { ruleset }.
 */
import { NextResponse } from "next/server";
import { DEFAULT_RULESET } from "@/lib/forcefield-web/ruleset";
import { getBlockedFingerprints } from "@/lib/forcefield/blocked-fingerprints";
import { getDatacenterPrefixes } from "@/lib/forcefield/datacenter-ranges";
import { getCrawlerRanges } from "@/lib/forcefield/crawler-ranges";
import { getIntentCarryover } from "@/lib/forcefield/intent-carryover";

export const runtime = "nodejs";

const EDGE_WORKSPACE_ID = process.env.FORCEFIELD_EDGE_WORKSPACE_ID || "default";

export async function GET() {
  // Distributed operator blocks: dark unless explicitly enabled, and fail-safe
  // to an empty list so a resolution error never turns real traffic away.
  let blockedFingerprints: string[] = [];
  if (process.env.FORCEFIELD_DISTRIBUTE_BLOCKS === "on") {
    blockedFingerprints = await getBlockedFingerprints(EDGE_WORKSPACE_ID).catch(() => []);
  }

  // Datacenter prefixes: the FULL provider set distributed to every site at once
  // (the united rollout). Fail-safe to empty so each site keeps its bundled seed.
  const datacenterPrefixes = await getDatacenterPrefixes().catch(() => []);

  // Verified-agent ranges: the vendors' own published crawler IP lists, so every
  // site can tell a real Googlebot/GPTBot/ClaudeBot from a UA impersonator. This
  // response is CDN-cached, so it may wait briefly for a cold refresh; fail-safe
  // to {} (every claimed agent "unverifiable", never an impersonation).
  const verifiedAgentRanges = await getCrawlerRanges({ waitMs: 3000 }).catch(() => ({}));

  // Intent carryover: distinctive fingerprints proven hostile on any Forcefield
  // site, each expiring (intent-carryover.ts). Consumed as tarpit only, never a
  // block. Fail-safe to [].
  const intentCarryover = await getIntentCarryover().catch(() => []);

  return NextResponse.json(
    { ruleset: { ...DEFAULT_RULESET, blockedFingerprints, datacenterPrefixes, verifiedAgentRanges, intentCarryover } },
    {
      status: 200,
      headers: {
        // Cache at the CDN for 5 minutes, serve stale while revalidating - the
        // ruleset changes rarely and a site's own fetch cache is the primary layer.
        // The 5-min TTL also bounds how long a fresh block takes to reach a site.
        "cache-control": "public, s-maxage=300, stale-while-revalidate=600",
      },
    },
  );
}
