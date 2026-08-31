/**
 * What sits in the knowledge base that must never reach a model.
 *
 * Measured on our own 5,006 chunks: 623 carry something the gate strips and 59
 * documents hold a never-send value. Card numbers and API keys, indexed and
 * quotable, removed at the boundary.
 */
import { scanExposure, describeExposure } from "../corpus-exposure";

const chunk = (documentId: string, content: string) => ({ documentId, content });

describe("what the gate would strip", () => {
  it("finds a card number and marks it never-send", () => {
    const r = scanExposure([chunk("doc-1", "Payment on card 4111 1111 1111 1111 was declined.")]);
    const card = r.byKind.find((k) => k.kind === "credit_card")!;
    expect(card.neverSend).toBe(true);
    expect(r.documentsWithNeverSend).toBe(1);
  });

  it("counts an ordinary contact detail without calling it never-send", () => {
    const r = scanExposure([chunk("doc-1", "Reach Dana on dana@example.com about the order.")]);
    expect(r.documentsWithNeverSend).toBe(0);
    expect(r.byKind.find((k) => k.kind === "email")?.neverSend).toBe(false);
  });

  /* Never-send first, because those are the ones that change what somebody
     does about it. */
  it("puts the values that never leave at the top", () => {
    const r = scanExposure([
      chunk("doc-1", "call 555 123 4567 or 555 765 4321 or 555 111 2222"),
      chunk("doc-2", "card 4111 1111 1111 1111"),
    ]);
    expect(r.byKind[0].neverSend).toBe(true);
  });

  it("counts a document once however many passages carry something", () => {
    const r = scanExposure([
      chunk("doc-1", "card 4111 1111 1111 1111"),
      chunk("doc-1", "card 4111 1111 1111 1111"),
    ]);
    expect(r.documentsWithSomething).toBe(1);
  });

  it("finds nothing in ordinary prose", () => {
    const r = scanExposure([chunk("doc-1", "The workshop covers communication and engagement.")]);
    expect(r.chunksWithSomething).toBe(0);
  });
});

describe("what it refuses to do", () => {
  /* A report that listed what it found would be a copy of the exposure it
     exists to describe, in a file easier to read than the original. */
  it("never carries a matched value", () => {
    const text = describeExposure(
      scanExposure([chunk("doc-1", "card 4111 1111 1111 1111 and dana@example.com")]),
    );
    expect(text).not.toContain("4111");
    expect(text).not.toContain("dana@example.com");
  });

  /* The finding is that the boundary holds, not that the documents are bad. */
  it("does not accuse anybody of anything", () => {
    const text = describeExposure(scanExposure([chunk("doc-1", "card 4111 1111 1111 1111")]));
    expect(text).toMatch(/not that anybody did anything wrong/i);
    /* Matched across the wrap, since the sentence is what matters and where
       it breaks is not. */
    expect(text).toMatch(/invoices contain card\s+numbers/i);
  });

  /* A compliance number carrying no idea of its own precision invites either
     panic or dismissal. */
  it("says how much each figure is worth", () => {
    const text = describeExposure(scanExposure([chunk("doc-1", "card 4111 1111 1111 1111")]));
    expect(text).toMatch(/checksum-validated/i);
    expect(text).toMatch(/Phone matching is looser/i);
  });

  /* An empty scan and a clean corpus are different facts. */
  it("does not let nothing scanned read as nothing found", () => {
    expect(describeExposure(scanExposure([]))).toMatch(/not the same as nothing being there/i);
  });

  it("treats a genuinely clean corpus as worth a second look", () => {
    const text = describeExposure(scanExposure([chunk("d", "plain prose about training")]));
    expect(text).toMatch(/Worth re-reading if the corpus contains invoices/i);
  });
});
