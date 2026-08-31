/**
 * What the knowledge base carries that never reaches a model.
 *
 * Proves the gate on real material rather than fixtures, and tells somebody
 * what their own corpus holds. Counts and kinds only: a report listing what it
 * found would be a copy of the exposure it describes.
 *
 *   npm run compliance:corpus
 */
import "./load-env";

import { query } from "@/lib/db";
import { scanExposure, describeExposure, type ScannedChunk } from "@/lib/insights/corpus-exposure";

async function main() {
  const { rows } = await query<{ document_id: string; content: string }>(
    `SELECT document_id, content FROM brain_chunks`,
  );
  const chunks: ScannedChunk[] = rows.map((r) => ({
    documentId: r.document_id,
    content: r.content,
  }));

  console.log("Corpus exposure\n");
  console.log(describeExposure(scanExposure(chunks)));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
