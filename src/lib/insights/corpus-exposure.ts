/**
 * What sits in the knowledge base that must never reach a model.
 *
 * TWO ANSWERS AT ONCE, AND THEY ARE DIFFERENT. It proves the gate works on
 * real material rather than on fixtures, and it tells somebody what their own
 * corpus is carrying. A client asks both questions and usually only gets the
 * first, in the form of an architecture diagram.
 *
 * Measured on our own 5,006 chunks: 623 hold something the gate strips, and 59
 * documents hold a value in the never-send set. Card numbers, API keys and
 * bank details, sitting in a SharePoint library, indexed and quotable, and
 * removed at the boundary before any of it reaches a provider.
 *
 * IT PROVES THE GATE, NOT THAT ANYBODY DID ANYTHING WRONG. Invoices contain
 * card numbers; that is what an invoice is. The finding is not that the
 * documents are bad, it is that the boundary holds, and that somebody should
 * know which documents carry what before deciding who may quote them.
 *
 * COUNTS AND KINDS, NEVER VALUES. A report that listed what it found would be
 * a copy of the exposure it exists to describe, in a file that is easier to
 * read than the original. Nothing here carries a matched value, and nothing
 * should ever be added that does.
 *
 * WHAT THE NUMBERS ARE WORTH. Card matches are Luhn-validated, so a
 * sixteen-digit invoice reference usually fails and a real card usually
 * passes: not proof, but far from a guess. Phone matching is deliberately
 * looser and will catch reference numbers, so it is reported and never
 * emphasised. Both are stated where the figure is, because a compliance
 * number carrying no idea of its own precision invites either panic or
 * dismissal.
 */

import { redactText, NEVER_SEND_KINDS, type RedactionKind } from "@/lib/ai/redaction";

export interface ScannedChunk {
  documentId: string;
  content: string;
}

export interface ExposureReading {
  chunksScanned: number;
  /** Chunks holding at least one value the gate would strip. */
  chunksWithSomething: number;
  /** Occurrences per kind. Counts only. */
  byKind: { kind: RedactionKind; occurrences: number; neverSend: boolean }[];
  /** Documents holding at least one never-send value. */
  documentsWithNeverSend: number;
  /** Documents holding anything at all. */
  documentsWithSomething: number;
}

export function scanExposure(chunks: readonly ScannedChunk[]): ExposureReading {
  const byKind = new Map<RedactionKind, number>();
  const docsAny = new Set<string>();
  const docsNeverSend = new Set<string>();
  let chunksWithSomething = 0;

  for (const chunk of chunks) {
    const result = redactText(chunk.content ?? "");
    if (result.hits.length === 0) continue;
    chunksWithSomething += 1;
    docsAny.add(chunk.documentId);
    for (const hit of result.hits) {
      byKind.set(hit.kind, (byKind.get(hit.kind) ?? 0) + 1);
      if (NEVER_SEND_KINDS.has(hit.kind)) docsNeverSend.add(chunk.documentId);
    }
  }

  return {
    chunksScanned: chunks.length,
    chunksWithSomething,
    byKind: [...byKind.entries()]
      .map(([kind, occurrences]) => ({
        kind,
        occurrences,
        neverSend: NEVER_SEND_KINDS.has(kind),
      }))
      /* Never-send first: they are the ones that change what somebody does. */
      .sort((a, b) => Number(b.neverSend) - Number(a.neverSend) || b.occurrences - a.occurrences),
    documentsWithNeverSend: docsNeverSend.size,
    documentsWithSomething: docsAny.size,
  };
}

/** What a person reads, with each figure's precision attached to it. */
export function describeExposure(r: ExposureReading): string {
  if (r.chunksScanned === 0) {
    return "Nothing was scanned, which is not the same as nothing being there.";
  }
  if (r.chunksWithSomething === 0) {
    return `${r.chunksScanned} passages scanned and none carried anything the gate strips. Worth re-reading if the corpus contains invoices or contracts, because that would be unusual.`;
  }

  const lines = [
    `${r.chunksWithSomething} of ${r.chunksScanned} passages carry something removed before it reaches a model.`,
    `${r.documentsWithSomething} document(s) are involved, ${r.documentsWithNeverSend} of them holding a value that is never sent at all.`,
    ``,
  ];

  for (const k of r.byKind) {
    const note = k.neverSend
      ? "  never sent to any provider"
      : "  removed from the prompt and restored in the answer";
    lines.push(`  ${k.kind.padEnd(14)} ${String(k.occurrences).padStart(5)}${note}`);
  }

  lines.push(
    ``,
    `This says the boundary holds, not that anybody did anything wrong: invoices contain card`,
    `numbers, which is what an invoice is. What it changes is who should be able to quote which`,
    `document, and that is a decision rather than a defect.`,
  );

  if (r.byKind.some((k) => k.kind === "credit_card")) {
    lines.push(
      `Card matches are checksum-validated, so a long invoice reference usually fails and a real`,
      `card usually passes. Phone matching is looser by design and will include reference numbers.`,
    );
  }
  return lines.join("\n");
}
