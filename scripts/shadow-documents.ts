/**
 * Documents the business circulated that the knowledge base has never seen.
 *
 * A file attached to a meeting is a document somebody thought mattered enough
 * to send. If it never reached the indexed corpus, no answer can cite it, and
 * nobody finds out except by asking a question and getting nothing.
 *
 *   npm run insights:shadow-docs
 */
import "./load-env";

import { query } from "@/lib/db";
import {
  findShadowDocuments,
  describeShadow,
  type CirculatedFile,
} from "@/lib/insights/shadow-documents";

async function main() {
  const { rows } = await query<{
    filename: string;
    mime: string | null;
    size_bytes: number | null;
  }>(
    `SELECT DISTINCT ON (lower(filename)) filename, mime, size_bytes
       FROM instinct_meeting_attachments
      WHERE filename IS NOT NULL AND length(trim(filename)) > 0
      ORDER BY lower(filename)`,
  );

  const circulated: CirculatedFile[] = rows.map((r) => ({
    filename: r.filename,
    mime: r.mime,
    sizeBytes: r.size_bytes,
    seenIn: "a meeting",
  }));

  const indexed = await query<{ filename: string }>(
    `SELECT filename FROM brain_documents WHERE status = 'indexed'`,
  );
  const reading = findShadowDocuments(circulated, new Set(indexed.rows.map((r) => r.filename)));

  console.log(`Shadow documents\n`);
  console.log(describeShadow(reading));

  if (reading.shadow.length > 0) {
    console.log(`\nCirculated, never indexed:`);
    for (const s of reading.shadow.slice(0, 20)) {
      const size = s.sizeBytes ? `${Math.round(s.sizeBytes / 1024)}kb` : "";
      console.log(`  ${size.padStart(7)}  ${s.filename.slice(0, 62)}`);
    }
  }

  /* THE LIMIT OF THIS DATA, SAID EVERY RUN. Received mail is not cached, so
     the only circulated files visible are the ones attached to meetings. The
     real estate of shadow documents is almost certainly larger, and reporting
     this number without that sentence would understate it. */
  console.log(
    `\nOnly files attached to MEETINGS are visible here: received mail is not cached,` +
      `\nso attachments sent by email are not counted. The real number is larger than this one.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
