/**
 * Check the phrasings people actually typed, not the ones I imagined.
 *
 * The phrase sweep is written by hand. Every phrasing in it is somebody's
 * guess at how a person would ask, and guesses are the reason it found
 * "arr" inside "warranty" but never thought of "how are you?".
 *
 * Production has the real list. Every message that reached no tool and
 * fell through to a model is recorded as assistant.intent_unmatched with
 * the text that missed. That is a backlog of genuine phrasings, ranked by
 * how often somebody typed them, and it costs nothing to replay against
 * the registry.
 *
 * WHAT THIS ANSWERS THAT THE HAND-WRITTEN SWEEP CANNOT. Whether a gap is
 * REAL. A phrasing I invented that nobody uses is a matcher I widened for
 * no reason, and widening carries trespass risk every time. A phrasing
 * somebody typed is a gap that has already cost us at least one bad
 * answer.
 *
 * It cannot say what SHOULD have answered: only a person can decide that
 * "i need the wolfpack letterhead" is a document lookup. So it prints the
 * misses ranked by frequency and leaves the judgment where it belongs.
 *
 * Usage:  DATABASE_URL=... npx tsx scripts/sweep-the-backlog.ts
 *         DATABASE_URL=... npx tsx scripts/sweep-the-backlog.ts --days 30
 */

import "@/lib/assistant/tools/index";
import { getTools } from "@/lib/assistant/tools/registry";

/* Long pastes are documents, not phrasings, and a single character is
   somebody clearing the box. Neither tells us anything about matching. */
const MIN_CHARS = 4;
const MAX_CHARS = 120;

function claimants(message: string): string[] {
  const out: string[] = [];
  for (const tool of getTools() as unknown as Array<{
    name: string;
    matchIntent?: (m: string) => unknown;
  }>) {
    try {
      if (tool.matchIntent && tool.matchIntent(message)) out.push(tool.name);
    } catch {
      /* a matcher that throws has its own test */
    }
  }
  return out;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required: this reads the production backlog.");
    process.exitCode = 1;
    return;
  }
  const daysArg = process.argv.indexOf("--days");
  const days = daysArg >= 0 ? Number(process.argv[daysArg + 1]) || 90 : 90;

  const { safeQuery } = await import("@/lib/db");
  const { rows } = await safeQuery<{ text: string; n: string; users: string }>(
    `SELECT lower(btrim(metadata->>'message_text')) AS text,
            COUNT(*)::bigint                        AS n,
            COUNT(DISTINCT user_id)::bigint         AS users
       FROM instinct_events
      WHERE event_type = 'assistant.intent_unmatched'
        AND metadata->>'message_text' IS NOT NULL
        AND length(metadata->>'message_text') BETWEEN $1 AND $2
        AND timestamp > NOW() - ($3::bigint || ' days')::interval
      GROUP BY 1
      ORDER BY n DESC, 1
      LIMIT 200`,
    [MIN_CHARS, MAX_CHARS, days],
  );

  if (rows.length === 0) {
    console.log("Nothing in the backlog for that window.");
    return;
  }

  const stillMissing: Array<{ text: string; n: number; users: number }> = [];
  const nowAnswered: Array<{ text: string; tool: string }> = [];

  for (const row of rows) {
    const hits = claimants(row.text);
    if (hits.length === 0) {
      stillMissing.push({ text: row.text, n: Number(row.n), users: Number(row.users) });
    } else {
      nowAnswered.push({ text: row.text, tool: hits[0] });
    }
  }

  /* The ones already closed are worth printing. They are the evidence
     that widening a matcher moved a real number rather than a
     hypothetical one, and they are the only feedback this loop gets. */
  console.log(`${rows.length} distinct phrasings missed in the last ${days} days.`);
  console.log(`${nowAnswered.length} of them now reach a tool. ${stillMissing.length} still do not.\n`);

  if (nowAnswered.length > 0) {
    console.log("── closed since they were logged");
    for (const a of nowAnswered.slice(0, 25)) {
      console.log(`  ${a.tool.padEnd(28)}"${a.text}"`);
    }
    console.log("");
  }

  console.log("── still reaching a model, most-typed first");
  for (const m of stillMissing.slice(0, 60)) {
    const who = m.users > 1 ? ` (${m.users} people)` : "";
    console.log(`  ${String(m.n).padStart(3)}x${who.padEnd(12)} "${m.text}"`);
  }

  console.log(
    `\nThese are phrasings somebody actually typed. A gap here has already ` +
      `cost at least one bad answer, which is what separates it from a gap ` +
      `in the hand-written sweep.`,
  );
}

void main();
