/**
 * Audit the retrieval eval pairs: does each pair's expected document actually
 * ANSWER its question? A mislabeled pair (the doc does not contain the answer)
 * counts as a retrieval "miss" that no retriever could ever satisfy, which
 * makes the recall number lie. This grades every pair with a cheap-tier judge
 * so the set can be cleaned and the number trusted. Repeatable, read-only.
 *
 *   npx tsx scripts/audit-eval-pairs.ts
 */
import "./load-env";
import { readFileSync, writeFileSync } from "node:fs";
import { getAIClient } from "@/lib/ai";
import { query } from "@/lib/db";

interface Pair { question: string; expectFilename: string; reviewed?: boolean }

async function main() {
  const pairs: Pair[] = JSON.parse(readFileSync("src/lib/brain/eval/retrieval-pairs.json", "utf8"));
  const client = getAIClient();
  const suspect: Array<Pair & { reason: string }> = [];
  const confirmed: Pair[] = [];
  const noDoc: Pair[] = [];
  console.log(`Auditing ${pairs.length} pairs...\n`);
  for (const p of pairs) {
    const { rows } = await query<{ content: string }>(
      `SELECT bc.content FROM brain_chunks bc JOIN brain_documents bd ON bd.id=bc.document_id
        WHERE bd.filename ILIKE '%' || $1 || '%' AND bd.status='indexed' ORDER BY bc.chunk_idx LIMIT 24`, [p.expectFilename]);
    if (!rows.length) { noDoc.push(p); console.log(`  [NO DOC] ${p.expectFilename} — not indexed`); continue; }
    const body = rows.map(r => r.content).join("\n").slice(0, 12000);
    const j = await client.complete({
      system: "You judge whether a DOCUMENT contains the answer to a QUESTION. Reply exactly 'YES' or 'NO' then one short reason. Be strict: YES only if the document actually contains the answer.",
      messages: [{ role: "user", content: `QUESTION: ${p.question}\n\nDOCUMENT:\n${body}` }],
      max_tokens: 60, model_tier: "cheap", latency_target: "batch",
    });
    const verdict = /^\s*yes/i.test(j.content) ? "YES" : "NO";
    if (verdict === "NO") {
      suspect.push({ ...p, reason: j.content.replace(/\s+/g, " ").trim().slice(0, 200) });
      console.log(`  [MISLABEL?] "${p.question.slice(0,55)}" -> ${p.expectFilename.slice(0,40)}\n              ${j.content.slice(0,110)}`);
    } else {
      confirmed.push(p);
    }
  }
  writeFileSync("src/lib/brain/eval/retrieval-pairs.confirmed.json", JSON.stringify(confirmed, null, 2) + "\n");
  writeFileSync("src/lib/brain/eval/retrieval-pairs.suspect.json", JSON.stringify(suspect, null, 2) + "\n");
  console.log(`\n=== ${pairs.length} pairs: ${suspect.length} suspected mislabel, ${noDoc.length} doc-not-indexed, ${confirmed.length} confirmed answerable ===`);
  console.log(`Wrote confirmed subset + suspect list (with reasons) to src/lib/brain/eval/.`);
  process.exit(0);
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
