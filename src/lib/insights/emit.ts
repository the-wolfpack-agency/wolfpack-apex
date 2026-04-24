/**
 * Standard insights emitter — every new feature MUST route its
 * analytics through `emitInsight()`. Single, predictable shape per
 * event regardless of which surface fired it.
 *
 * Bundle-safe by design:
 *   - Client side ("use client" components): POSTs to /api/analytics.
 *     No server-only deps reach the browser bundle.
 *   - Server side (route handlers, server actions): dynamic-imports
 *     the trackEvent helper — keeps Next.js from bundling pg /
 *     analytics machinery into the client.
 *
 * Future Azure swap: change the server branch to write Application
 * Insights / Log Analytics. Consumers don't change.
 *
 * Role-tier rule of thumb:
 *   - "personal"  — visible to the actor in their own insights view.
 *   - "org"       — aggregates across users (responsiveness, mention
 *                   follow-through, AI cost per-team, etc.). Insights
 *                   queries that touch org-tier rows MUST gate on
 *                   requireCapability("org.insights") server-side.
 */

export type InsightTier = "personal" | "org";
export type InsightSurface =
  | "chat"
  | "channel"
  | "email"
  | "calendar"
  | "search"
  | "assistant"
  | "tasks"
  | "sites"
  | "knowledge";

export interface InsightEvent {
  /** user_id (the person whose action this is). */
  actor: string;
  /** user role at fire time — cached for fast role-gated queries. */
  role: string;
  surface: InsightSurface;
  /** Verb in past tense ("sent", "drafted", "searched", …). */
  action: string;
  /** Optional id of the thing acted on (chat id, msg id, etc.). */
  target?: string;
  tier: InsightTier;
  /** Feature-specific scalars (length, latency, edit_distance, …). */
  payload: Record<string, string | number | boolean>;
}

function eventNameFor(e: InsightEvent): string {
  return `insight.${e.surface}.${e.action}`;
}

function buildMetadata(e: InsightEvent): Record<string, string | number | boolean> {
  return {
    surface: e.surface,
    action: e.action,
    tier: e.tier,
    target: e.target ?? "",
    ...e.payload,
  };
}

function getClientToken(): string | null {
  try {
    return (
      window.localStorage.getItem("instinct_token") ??
      window.localStorage.getItem("apex_token") ??
      null
    );
  } catch {
    return null;
  }
}

export function emitInsight(e: InsightEvent): void {
  // Browser path: never import server-only modules. POST to the
  // existing /api/analytics endpoint, which forwards to trackEvent
  // server-side. Fire-and-forget — UX never blocks on telemetry.
  if (typeof window !== "undefined") {
    const token = getClientToken();
    void fetch("/api/analytics", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        event: eventNameFor(e),
        metadata: buildMetadata(e),
      }),
    }).catch(() => {
      /* telemetry failure is non-fatal */
    });
    return;
  }

  // Server path: dynamic import so the client bundle never pulls
  // in @/lib/analytics → @/lib/db (pg). Fire-and-forget Promise.
  void (async () => {
    try {
      const mod = await import("@/lib/analytics");
      mod.trackEvent(
        eventNameFor(e) as Parameters<typeof mod.trackEvent>[0],
        e.actor,
        e.role,
        buildMetadata(e),
      );
    } catch {
      /* telemetry import / write failure is non-fatal */
    }
  })();
}
