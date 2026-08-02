/**
 * The document, brief and knowledge prompts, registered.
 *
 * A prompt migration is a MOVE, not a rewrite. The only way that claim is worth
 * anything is if something checks it, so these tests pin the exact instructions
 * the models were already following. If a future edit changes the text, it
 * fails here and the author has to bump the version deliberately — which is the
 * whole reason the registry exists.
 *
 * Everything else here is about scope. Each of these four reads content someone
 * else supplied and returns something the system acts on, which is the shape
 * where a model is most likely to be talked into doing something adjacent to
 * its job.
 */
import { renderPrompt } from "../registry";
import { DOCUMENT_CLASSIFY, BRIEF_EXTRACT, KNOWLEDGE_ANSWER, SUPPORT_SELF_SERVE_ANSWER } from "../definitions/documents";

const ALL = [DOCUMENT_CLASSIFY, BRIEF_EXTRACT, KNOWLEDGE_ANSWER, SUPPORT_SELF_SERVE_ANSWER];

describe("every registered prompt declares what it may not do", () => {
  it.each(ALL)("$id names something out of scope", (prompt) => {
    // The registry requires a non-empty outOfScope for a reason: "everything
    // not listed above" is exactly the ambiguity that lets a model treat live
    // infrastructure as part of an exercise.
    expect(prompt.scope.outOfScope.length).toBeGreaterThan(0);
    expect(prompt.scope.inScope.length).toBeGreaterThan(0);
  });

  it.each(ALL)("$id has a stable id and a version", (prompt) => {
    expect(prompt.id).toMatch(/^[a-z_]+\.[a-z_]+$/);
    expect(prompt.version).toBeGreaterThanOrEqual(1);
  });

  it("uses distinct ids, so analytics and evals can tell them apart", () => {
    expect(new Set(ALL.map((p) => p.id)).size).toBe(ALL.length);
  });

  it("renders deterministically, so a version pins one exact text", () => {
    for (const p of ALL) expect(renderPrompt(p, {})).toBe(renderPrompt(p, {}));
  });
});

describe("document.classify", () => {
  const text = renderPrompt(DOCUMENT_CLASSIFY, {});

  it("still lists every document type the classifier's parser accepts", () => {
    // The parser validates against this union. A type silently dropped from
    // the prompt becomes a type the model never returns, and nothing fails.
    for (const type of ["receipt", "invoice", "tax_w2", "tax_1099", "id_document", "unknown"]) {
      expect(text).toContain(`"${type}"`);
    }
  });

  it("still forbids repeating the top pick in alternates", () => {
    expect(text).toContain("Do NOT repeat the top-pick type in alternates.");
  });

  it("still caps the rationale, because the column it lands in is bounded", () => {
    expect(text).toContain("rationale must be <= 240 characters");
  });

  it("still demands bare JSON with no fences", () => {
    expect(text).toContain("No markdown fences.");
  });

  it("refuses to follow instructions written inside the document it is reading", () => {
    // A document is untrusted input. Classifying it must not mean obeying it.
    expect(DOCUMENT_CLASSIFY.scope.outOfScope.join(" ")).toMatch(/instruction written inside the document/i);
  });

  it("does not extract contents, which is a different job with different consent", () => {
    expect(DOCUMENT_CLASSIFY.scope.outOfScope.join(" ")).toMatch(/extracting or reporting the document's contents/i);
  });
});

describe("brief.extract", () => {
  const text = renderPrompt(BRIEF_EXTRACT, {});

  it("still declares the SiteBrief shape the parser validates against", () => {
    expect(text).toContain("interface SiteBrief");
    for (const section of ["hero", "text", "callout", "banner", "stats", "cards", "gallery", "quote"]) {
      expect(text).toContain(`"${section}"`);
    }
  });

  it("still requires stats values to be numbers", () => {
    // The renderer does arithmetic on these. A string here is a crash there.
    expect(text).toContain("stats.items[].value MUST be a number");
  });

  it("still requires gallery.images to be an array even when empty", () => {
    expect(text).toContain("gallery.images MUST be an array even if empty");
  });

  it("refuses to invent copy the brief does not contain", () => {
    // This output becomes a client's website. Invented marketing copy is the
    // worst possible failure here.
    expect(BRIEF_EXTRACT.scope.outOfScope.join(" ")).toMatch(/inventing pages, sections or copy/i);
  });
});

describe("knowledge.answer", () => {
  const text = renderPrompt(KNOWLEDGE_ANSWER, {});

  it("still tells the model to say so plainly rather than invent", () => {
    expect(text).toContain("never invent");
  });

  it("still asks for a citation", () => {
    expect(text).toContain("Cite the source when possible.");
  });

  it("is scoped to the supplied documentation, not to general knowledge", () => {
    expect(KNOWLEDGE_ANSWER.scope.outOfScope.join(" ")).toMatch(/outside the supplied documentation/i);
  });
});

describe("support.self_serve_answer", () => {
  const text = renderPrompt(SUPPORT_SELF_SERVE_ANSWER, {});

  it("still recommends a ticket when it cannot answer with confidence", () => {
    // The whole point of this prompt: a confident wrong answer costs more than
    // a ticket does.
    expect(text).toContain("recommend they submit a support ticket");
    expect(text).toContain("say so explicitly");
  });

  it("must not assert anything about the member's account", () => {
    // It has no visibility into licences or tickets, so anything it says about
    // them is a guess delivered with authority.
    expect(SUPPORT_SELF_SERVE_ANSWER.scope.outOfScope.join(" ")).toMatch(/account, licences or tickets/i);
  });

  it("is a different prompt from knowledge.answer, not a variant of it", () => {
    // They answer different people in different situations. Collapsing them
    // would lose the ticket recommendation.
    expect(renderPrompt(SUPPORT_SELF_SERVE_ANSWER, {})).not.toBe(renderPrompt(KNOWLEDGE_ANSWER, {}));
  });
});
