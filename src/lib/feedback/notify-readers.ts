/**
 * notify-readers: when new feedback lands, tell the people who can act on it.
 *
 * "Act on it" means the same gate as the /admin/feedback inbox itself:
 * settings.manage_team. For the current single-CTO tenant that is just the
 * CTO, which is exactly the "notify me so I stop missing feedback" ask. We
 * resolve the readers through the canonical capability resolver rather than
 * hard-coding roles, so a per-user grant or a future manager role is picked
 * up automatically and a revoke is honored.
 *
 * Delivery reuses the existing in-app notifications layer (the bell), which
 * already records a row per recipient, respects each user's preferences,
 * dedupes, and can fan out to email via the digest. We deliberately did NOT
 * add Slack or a new channel: the feedback table exists precisely so the team
 * does not depend on Slack/Linear.
 *
 * This is best-effort. It never throws into the feedback write path: a flaky
 * preferences read must never lose a submitted note.
 */

import { safeQuery } from "@/lib/db";
import { notify } from "@/lib/notifications/in-app";
import { effectiveCapabilitiesFor } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import type { TeamMember } from "@/lib/auth";

export interface NotifyFeedbackReadersInput {
  workspaceId: string;
  feedbackId: string;
  /** Author of the feedback. Excluded from the recipients: you do not need
   *  a notification about your own note. */
  authorUserId: string;
  authorRole?: string;
  /** A short label for who filed it, e.g. the role or email. */
  authorLabel?: string;
  message: string;
  surface?: string;
}

/** Capability that gates the /admin/feedback inbox; the readers we notify. */
const FEEDBACK_READER_CAPABILITY = "settings.manage_team" as const;

/** Trim the message into a one-line notification body. */
export function feedbackPreview(message: string, max = 140): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

interface ActiveMemberRow {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
  workspace_id: string | null;
}

/**
 * Notify every feedback reader in the workspace (except the author) about a
 * new feedback row. Returns the recipient count. Swallows all errors.
 */
export async function notifyFeedbackReaders(
  input: NotifyFeedbackReadersInput,
): Promise<{ recipientCount: number }> {
  let recipientCount = 0;
  try {
    const { rows } = await safeQuery<ActiveMemberRow>(
      `SELECT id, email, name, role, workspace_id
         FROM instinct_team_members
        WHERE workspace_id = $1 AND is_active = true`,
      [input.workspaceId],
    );

    const who = input.authorLabel || input.authorRole || "a teammate";
    const title = `New feedback from ${who}`;
    const body = feedbackPreview(input.message);

    for (const row of rows) {
      if (row.id === input.authorUserId) continue;
      try {
        const member: TeamMember = {
          id: row.id,
          email: row.email ?? "",
          name: row.name ?? "",
          role: (row.role as TeamMember["role"]) ?? "ops",
          workspaceId: row.workspace_id ?? input.workspaceId,
          created_at: "",
        };
        const { capabilities } = await effectiveCapabilitiesFor(member);
        if (!capabilities.has(FEEDBACK_READER_CAPABILITY)) continue;

        await notify({
          userId: row.id,
          category: "feedback",
          priority: "normal",
          title,
          body,
          actionUrl: "/admin/feedback",
          actionLabel: "Open feedback",
          source: "feedback",
          sourceId: input.feedbackId,
          metadata: {
            feedback_id: input.feedbackId,
            author_user_id: input.authorUserId,
            author_role: input.authorRole ?? "unknown",
            surface: input.surface ?? "unknown",
          },
          dedup: true,
        });
        recipientCount += 1;
      } catch (err) {
        console.warn(
          `[feedback notify] skip ${row.id}:`,
          (err as Error).message,
        );
      }
    }

    trackEvent(
      "assistant.feedback_notified",
      input.authorUserId,
      input.authorRole ?? "unknown",
      {
        feedback_id: input.feedbackId,
        recipient_count: recipientCount,
        surface: input.surface ?? "unknown",
      },
    );
  } catch (err) {
    console.warn("[feedback notify] fanout failed:", (err as Error).message);
  }
  return { recipientCount };
}
