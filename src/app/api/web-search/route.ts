/**
 * POST /api/web-search - authed web search for agents (and any caller).
 *
 * Body: { query: string, limit?: number }.
 *
 * Contract:
 *   - 401 when the request carries no valid user (getUserFromRequest -> null).
 *   - 400 when `query` is missing / not a non-empty string.
 *   - Otherwise ALWAYS 200 with the WebSearchResponse JSON. The `ok` flag (not
 *     the HTTP status) carries success / not-configured / provider-error, so an
 *     agent operation gets a clean, inspectable result rather than a 5xx that
 *     would blank a UI or fail a task run. A thrown error is caught and returned
 *     as a 200 { ok:false, ... } so this route never 500s.
 *
 * SECURITY: searchWeb only ever calls the configured provider's own endpoint
 * (no SSRF - never a user URL) and never logs provider keys.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { searchWeb, type WebSearchResponse } from "@/lib/integrations/web-search";

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await req.json().catch(() => ({}))) as {
      query?: unknown;
      limit?: unknown;
    };

    const query = body.query;
    if (typeof query !== "string" || query.trim().length === 0) {
      return NextResponse.json(
        { error: "query is required and must be a non-empty string" },
        { status: 400 },
      );
    }

    const limit =
      typeof body.limit === "number" && Number.isFinite(body.limit)
        ? body.limit
        : undefined;

    const result: WebSearchResponse = await searchWeb(query, { limit });

    // Minimal analytics: reuse the existing tool-invocation event (no new event
    // type, no key in metadata). Fire-and-forget; trackEvent never throws.
    trackEvent("assistant.tool_invoked", user.id, user.role, {
      tool: "web_search",
      provider: result.provider,
      ok: result.ok,
      result_count: result.results.length,
    });

    // ALWAYS 200: the ok flag carries the real outcome.
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    // Belt-and-braces: never 500. searchWeb already never throws, so this only
    // fires on an unexpected runtime fault (e.g. malformed request object).
    const message = err instanceof Error ? err.message : "web search failed";
    const fallback: WebSearchResponse = {
      ok: false,
      provider: "none",
      results: [],
      error: message,
    };
    return NextResponse.json(fallback, { status: 200 });
  }
}
