/**
 * The predicate that stops the assistant caching a refusal.
 *
 * THE FIXTURES ARE REAL. Every string in the first block was read back from
 * the deployed assistant or lifted verbatim from instinct_knowledge in
 * production on 2026-08-28. Invented examples would prove the regex matches
 * what I imagined the model says, which is the thing that was already wrong:
 * the existing low-confidence filter caught "did you mean" for three months
 * while "I cannot send emails directly" walked past it and was stored as fact.
 */
import {
  deniesCapability,
  capabilityDenialSql,
} from "@/lib/assistant/capability-denial";

describe("answers that were being served to clients", () => {
  /* Each of these came back from cache, not from a model, and each is false:
     the product holds Mail.Send, reads seventeen Graph surfaces, and answered
     a tasks question correctly two prompts before denying it could. */
  it.each([
    ["I cannot send emails directly.", "mail"],
    ["I cannot check your open tasks.", "tasks"],
    [
      "I don't have direct access to your file system or repository. To assist you, you can share file paths, filenames, or relevant code snippets.",
      "files",
    ],
    ["I cannot determine who runs engineering based on the information provided.", "people"],
    [
      "I cannot directly access or analyze the contents of your file, but I can guide you on how to perform this analysis.",
      "documents",
    ],
    ["I do not have access to meeting records or personal schedules.", "meetings"],
    [
      'I cannot access or retrieve the contents of the "TWA Agenda 4.20" document directly.',
      "a named document",
    ],
    ["I cannot view screenshots or attachments directly.", "attachments"],
    ["I cannot directly fetch real-time articles or browse the web.", "the web"],
  ])("refuses to cache %j", (answer) => {
    expect(deniesCapability(answer)).toBe(true);
  });
});

describe("answers that must survive", () => {
  /* THE ONE THE WHOLE FILE IS AT RISK OF BREAKING. This is the copy we want:
     it names what is missing and where to fix it, and it is not a denial. A
     predicate that swallowed this would replace a useful answer with a model
     call and nobody would notice for months. */
  it("keeps an honest not-connected-yet, which names where to go", () => {
    expect(
      deniesCapability(
        "I understood the question, but financials are not connected yet, so there is no figure to read. Connect QuickBooks in Admin, Connectors and I will be able to answer this.",
      ),
    ).toBe(false);
  });

  it("keeps a real answer that happens to contain a refusal about someone else", () => {
    expect(
      deniesCapability(
        "The policy states that employees cannot access the building after 8pm without a badge escort.",
      ),
    ).toBe(false);
  });

  /* Third-person prose about inability is somebody's document, not the
     assistant talking about itself. */
  it("keeps a document quote in which a third party cannot do something", () => {
    expect(
      deniesCapability("The vendor cannot send invoices until the PO is countersigned."),
    ).toBe(false);
  });

  it("keeps an ordinary answer", () => {
    expect(deniesCapability("There are 9 people on the team, listed by area below.")).toBe(false);
    expect(deniesCapability("")).toBe(false);
  });
});

describe("the SQL form, which guards the cache read and the purge", () => {
  /* The SQL is hand-written rather than translated from the regexes, so the
     one thing worth asserting is that it is valid, negated, and bound to the
     column it was handed. A wrong column reference here silently disables the
     entire filter, which is exactly how the assistant cache broke once before
     when a LATERAL subquery selected one column and the WHERE named another. */
  it("references only the column it was given", () => {
    const sql = capabilityDenialSql("a.content");
    expect(sql).toContain("a.content NOT ILIKE");
    expect(sql).not.toContain("answer NOT ILIKE");
  });

  it("negates every clause, so a match excludes the row", () => {
    const clauses = capabilityDenialSql("x").split("AND");
    expect(clauses.length).toBeGreaterThan(5);
    for (const c of clauses) expect(c.trim()).toMatch(/^x NOT ILIKE '/);
  });

  /* Postgres string literals: an apostrophe that is not doubled ends the
     literal early and turns the rest of the filter into a syntax error, which
     would fail the query and take the whole cache read down with it. */
  it("escapes apostrophes so the literals are valid Postgres", () => {
    const sql = capabilityDenialSql("x");
    for (const literal of sql.match(/'[^']*(?:''[^']*)*'/g) ?? []) {
      const inner = literal.slice(1, -1);
      expect(inner.replace(/''/g, "")).not.toContain("'");
    }
  });

  /* The two nets are allowed to differ, and the SQL one is deliberately wider.
     What is not allowed is the SQL missing something the TypeScript catches:
     that would mean an answer we refuse to write is still replayed from rows
     written before the fix. */
  it("catches at least everything the TypeScript predicate catches", () => {
    const sql = capabilityDenialSql("x").toLowerCase();
    for (const answer of [
      "I cannot send emails directly.",
      "I don't have direct access to your file system.",
      "I am unable to check that.",
    ]) {
      expect(deniesCapability(answer)).toBe(true);
      const lower = answer.toLowerCase();
      const covered = (sql.match(/'%([^']*(?:''[^']*)*)%'/g) ?? []).some((frag) =>
        lower.includes(frag.slice(2, -2).replace(/''/g, "'")),
      );
      expect(covered).toBe(true);
    }
  });
});

/**
 * WHO WROTE IT DECIDES WHETHER IT IS SUPPRESSED.
 *
 * The unscoped filter above is right for the WRITE guard, which only ever sees
 * model output. On the READ side it was too broad: a person deliberately
 * curating "I cannot approve anything over ten thousand without a second
 * signature" would have their own entry silently hidden from search and from
 * the Knowledge page, with nothing to tell them why.
 *
 * Measured on production before the change: 3 rows hidden, all source=ai, so
 * nothing human was being suppressed. Measured after: the same 3, with all 9
 * human and 16 docs rows served. This closes the gap before somebody writes
 * the sentence that would have hit it.
 *
 * A human writing a refusal is making a decision. A model writing one is
 * usually wrong about this product, which is the finding behind the whole file.
 */
import { capabilityDenialSqlForModelAnswers } from "@/lib/assistant/capability-denial";

describe("the read filter only suppresses what a model wrote", () => {
  it("lets any non-model row through whatever it says", () => {
    const sql = capabilityDenialSqlForModelAnswers("answer", "source");
    expect(sql).toContain("source IS DISTINCT FROM 'ai'");
  });

  /* IS DISTINCT FROM rather than <>, because a NULL source would make a plain
     inequality evaluate to NULL and drop the row. An entry with no recorded
     provenance is not a model answer and must not be suppressed as one. */
  it("keeps rows whose provenance is unrecorded", () => {
    expect(capabilityDenialSqlForModelAnswers("answer", "source")).toMatch(
      /IS DISTINCT FROM/,
    );
  });

  it("still applies the full denial test to model answers", () => {
    const sql = capabilityDenialSqlForModelAnswers("answer", "source");
    expect(sql).toContain("answer NOT ILIKE");
    expect(sql.match(/answer NOT ILIKE/g)!.length).toBeGreaterThan(5);
  });

  /* Both columns are interpolated, so both need the same structural proof the
     single-column form has. A caller that passed reader input for either would
     otherwise have written an injection. */
  it.each([
    ["answer; DROP TABLE x", "source"],
    ["answer", "source; DROP TABLE x"],
    ["", "source"],
  ])("refuses to build SQL around %j / %j", (a, b) => {
    expect(() => capabilityDenialSqlForModelAnswers(a, b)).toThrow();
  });

  it("accepts ordinary and table-qualified column names", () => {
    expect(() => capabilityDenialSqlForModelAnswers("answer", "source")).not.toThrow();
    expect(() => capabilityDenialSqlForModelAnswers("k.answer", "k.source")).not.toThrow();
  });
});
