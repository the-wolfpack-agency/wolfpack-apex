import { safeQuery } from "@/lib/db";
import { notify } from "@/lib/notifications/in-app";
import { trackEvent, type InstinctEventType } from "@/lib/analytics";

export interface TeamFanoutInput {
  actor: { id: string; role: string; name?: string | null; email?: string | null };
  title: string;
  body: string;
  actionUrl: string;
  actionLabel?: string;
  category: Parameters<typeof notify>[0]["category"];
  source: string;
  sourceId: string;
  metadata?: Record<string, unknown>;
  analyticsEvent: InstinctEventType;
  analyticsPayload?: Record<string, unknown>;
  excludeActor?: boolean;
  /**
   * Restrict delivery to these member emails only. Omit for the default
   * whole-team fanout. Callers use this to keep an alert scoped to its owners
   * (e.g. a security tool still in testing that must not notify the whole team).
   */
  recipientEmails?: string[];
}

export interface TeamFanoutResult {
  recipientCount: number;
  skipped: number;
}

/**
 * Fan out one in-app notification per active teammate.
 *
 * Best-effort: per-recipient failures are logged and skipped so the
 * caller's write path can never be broken by a flaky preferences read.
 * Caller decides the role gate (we don't inspect `actor.role` here — some
 * callers want admin-only fanout, others want any-authed).
 */
export async function fanoutToTeam(
  input: TeamFanoutInput,
): Promise<TeamFanoutResult> {
  let recipientCount = 0;
  let skipped = 0;
  try {
    const scopeEmails = input.recipientEmails && input.recipientEmails.length ? input.recipientEmails : null;
    const { rows } = await safeQuery<{ id: string }>(
      `SELECT id FROM instinct_team_members
        WHERE is_active = true
          AND ($1::text[] IS NULL OR email = ANY($1))`,
      [scopeEmails],
    );
    for (const row of rows) {
      if (input.excludeActor && row.id === input.actor.id) continue;
      try {
        await notify({
          userId: row.id,
          category: input.category,
          priority: "normal",
          title: input.title,
          body: input.body,
          actionUrl: input.actionUrl,
          actionLabel: input.actionLabel ?? "View",
          source: input.source,
          sourceId: input.sourceId,
          metadata: {
            ...(input.metadata ?? {}),
            actor_id: input.actor.id,
            actor_role: input.actor.role,
          },
          dedup: true,
        });
        recipientCount += 1;
      } catch (err) {
        skipped += 1;
        console.warn(
          `[team-fanout] skip ${row.id}:`,
          (err as Error).message,
        );
      }
    }
    trackEvent(input.analyticsEvent, input.actor.id, input.actor.role, {
      ...(input.analyticsPayload ?? {}),
      recipient_count: recipientCount,
      actor_role: input.actor.role,
    });
  } catch (err) {
    console.warn("[team-fanout] fanout failed:", (err as Error).message);
  }
  return { recipientCount, skipped };
}

export function actorLabel(actor: TeamFanoutInput["actor"]): string {
  return actor.name || actor.email || actor.id;
}
