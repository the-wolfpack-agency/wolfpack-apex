/**
 * What the knowledge base carries that never reaches a model, on demand.
 *
 * ON DEMAND RATHER THAN ON LOAD, and that is not a UI preference. Scanning
 * every indexed passage takes seconds and reads the whole corpus, so doing it
 * on every page view would make a dashboard slow and would run a full scan
 * because somebody opened a tab. It is a thing a person asks for.
 *
 * KINDS AND COUNTS, NEVER VALUES. The response names documents and what they
 * carry, which is a work queue. It never carries a matched value, which would
 * be a copy of the exposure in a payload easier to read than the original and
 * easier still to forward.
 *
 * Gated on reports.view rather than assistant.use. Knowing which documents
 * hold a card number is a narrower thing than being allowed to ask questions,
 * and it points at where to look.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { query } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { scanExposure, type ScannedChunk } from "@/lib/insights/corpus-exposure";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Enough to work through, and bounded so one request cannot return the estate. */
const MAX_DOCUMENTS_RETURNED = 100;

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "reports.view");
  if (!auth.ok) return auth.response;

  const started = Date.now();
  const { rows } = await query<{ document_id: string; content: string; filename: string }>(
    `SELECT c.document_id, c.content, d.filename
       FROM brain_chunks c
       JOIN brain_documents d ON d.id = c.document_id
      WHERE d.status = 'indexed'`,
  );

  const chunks: ScannedChunk[] = rows.map((r) => ({
    documentId: r.document_id,
    content: r.content,
    filename: r.filename,
  }));

  const reading = scanExposure(chunks);

  /* Recorded like any other read of sensitive-adjacent material. Somebody
     asking which documents hold a card number is a thing worth being able to
     answer later. */
  trackEvent("system.audit_log_viewed", auth.user.id, auth.user.role, {
    module: "pilot",
    surface: "corpus_exposure",
    documents_scanned: reading.documentsWithSomething,
    never_send_documents: reading.documentsWithNeverSend,
  });

  return NextResponse.json({
    chunksScanned: reading.chunksScanned,
    chunksWithSomething: reading.chunksWithSomething,
    byKind: reading.byKind,
    documentsWithSomething: reading.documentsWithSomething,
    documentsWithNeverSend: reading.documentsWithNeverSend,
    /* Truncated deliberately, and the count above says how many exist, so a
       shortened list never reads as the whole answer. */
    documents: reading.documents.slice(0, MAX_DOCUMENTS_RETURNED),
    truncated: reading.documents.length > MAX_DOCUMENTS_RETURNED,
    durationMs: Date.now() - started,
  });
}
