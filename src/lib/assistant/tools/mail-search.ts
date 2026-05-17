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
    /* findThreadsInvolvingAttendees is "anyone-on-the-thread" matching
     * — sender OR recipient. Pull a wider pool so the strict
     * sender-side filter below has room to keep `limit` results. */
    threads = await findThreadsInvolvingAttendees(
      params.userId,
      from ? [from] : [],
      [],
      from ? Math.max(limit * 4, 20) : limit,
    );
  } catch {
    return null;
  }

  /* Strict "from <sender>" filter — the upstream matcher hits TO + CC
   * too, which is why "emails from Max" was returning threads where
   * Max was just a recipient. Keep only rows where the sender's name
   * or address actually contains the needle. */
  const fromNeedle = from?.toLowerCase().trim();
  const fromFiltered = fromNeedle
    ? threads.filter((t) => {
        const hay = `${t.from ?? ""} ${(t as Email & { fromEmail?: string }).fromEmail ?? ""}`.toLowerCase();
        return hay.includes(fromNeedle);
      })
    : threads;

  // Topic filter (substring on subject + cleaned body, case-insensitive).
  // Matching against the scrubbed preview keeps us from false-positive
  // matching on Teams invite URLs, signatures, or quoted-reply headers.
  const topicNeedle = topic?.toLowerCase();
  const filtered = topicNeedle
    ? fromFiltered.filter((t) => {
        const hay = `${t.subject} ${cleanMailSnippet(t.bodyPreview)}`.toLowerCase();
        return hay.includes(topicNeedle);
      })
    : fromFiltered;

  if (filtered.length === 0) return null;

  const matches = filtered.slice(0, limit).map((t) => ({
    id: t.id,
    subject: t.subject,
    from: t.from,
    receivedDateTime: t.receivedDateTime,
    preview: cleanMailSnippet(t.bodyPreview, 200),
    webLink: (t as Email & { webLink?: string }).webLink,
  }));

  /* Subject renders as a markdown link when we have a webLink — the
   * chat surface's markdown renderer turns this into a clickable
   * anchor that opens the message in Outlook on the web. Falls back
   * to plain text when Graph didn't return a webLink. */
  const summary = matches
    .slice(0, 5)
    .map((m) => {
      const date = new Date(m.receivedDateTime).toLocaleDateString();
      const subjectMd = m.webLink
        ? `[${m.subject}](${m.webLink})`
        : m.subject;
      return `• ${subjectMd} — ${m.from} (${date})`;
    })
    .join("\n");

  const qual = [from ? `from ${from}` : null, topic ? `about ${topic}` : null]
    .filter(Boolean)
    .join(" ");
  const more = matches.length > 5 ? ` (+${matches.length - 5} more)` : "";
  const answer = `Found ${matches.length} email${matches.length === 1 ? "" : "s"} ${qual}${more}:\n${summary}`;

  return { from, topic, matches, answer, source: "mail" };
}
