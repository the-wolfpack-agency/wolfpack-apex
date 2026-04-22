/**
 * mail_search tool — reuses the email-matcher built for prebriefs.
 *
 * Handles "find the email from James about Q2", "email from Hoxsie",
 * "email about Porsche engagement" etc. Takes optional "from" and
 * "topic" slots. If both are absent, returns null.
 */

import { findThreadsInvolvingAttendees } from "@/lib/meetings/email-matcher";
import type { Email } from "@/lib/microsoft-graph";
import { cleanMailSnippet } from "@/lib/mail/snippet";

export interface MailSearchResult {
  from?: string;
  topic?: string;
  matches: Array<{
    id: string;
    subject: string;
    from: string;
    receivedDateTime: string;
    preview: string;
    webLink?: string;
  }>;
  answer: string;
  source: "mail";
}

export async function runMailSearch(params: {
  userId: string;
  from?: string;
  topic?: string;
  limit?: number;
}): Promise<MailSearchResult | null> {
  const from = params.from?.trim();
  const topic = params.topic?.trim();
  if (!from && !topic) return null;
  const limit = Math.max(1, Math.min(params.limit ?? 5, 10));

  let threads: Email[] = [];
  try {
    threads = await findThreadsInvolvingAttendees(
      params.userId,
      from ? [from] : [],
      [],
      limit,
    );
  } catch {
    return null;
  }

  // Topic filter (substring on subject + cleaned body, case-insensitive).
  // Matching against the scrubbed preview keeps us from false-positive
  // matching on Teams invite URLs, signatures, or quoted-reply headers.
  const topicNeedle = topic?.toLowerCase();
  const filtered = topicNeedle
    ? threads.filter((t) => {
        const hay = `${t.subject} ${cleanMailSnippet(t.bodyPreview)}`.toLowerCase();
        return hay.includes(topicNeedle);
      })
    : threads;

  if (filtered.length === 0) return null;

  const matches = filtered.slice(0, limit).map((t) => ({
    id: t.id,
    subject: t.subject,
    from: t.from,
    receivedDateTime: t.receivedDateTime,
    preview: cleanMailSnippet(t.bodyPreview, 200),
    webLink: (t as Email & { webLink?: string }).webLink,
  }));

  const summary = matches
    .slice(0, 3)
    .map(
      (m) =>
        `• ${m.subject} — ${m.from} (${new Date(m.receivedDateTime).toLocaleDateString()})`,
    )
    .join("\n");

  const qual = [from ? `from ${from}` : null, topic ? `about ${topic}` : null]
    .filter(Boolean)
    .join(" ");
  const answer = `Found ${matches.length} email${matches.length === 1 ? "" : "s"} ${qual}:\n${summary}`;

  return { from, topic, matches, answer, source: "mail" };
}
