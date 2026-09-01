/**
 * The eval set is a measurement, so it gets checked like one.
 *
 * These twelve pairs decided whether query expansion shipped and which trigger
 * it shipped with. A bad pair does not fail loudly: it quietly moves a number
 * that a production decision then rests on, which is worse than having no
 * number because it carries the authority of a test.
 *
 * The failure worth guarding hardest is the self-answering pair. "Meeting
 * Notes with McDonalds" expecting the file "Meeting Notes with McDonalds" was
 * the single most-cited candidate the harvester found, 52 citations, and
 * retrieval cannot fail it. Accepting it would have raised recall while
 * changing nothing about the product.
 */

import fs from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), "src", "lib", "brain", "eval");

import { namesTheFile, collidingPairs } from "@/lib/brain/eval/pair-quality";

interface Pair {
  question: string;
  expectFilename: string;
  reviewed?: boolean;
  /** Generated candidates carry the evidence a reviewer needs. */
  passage?: string;
  answer?: string;
}

const pairs: Pair[] = JSON.parse(
  fs.readFileSync(path.join(DIR, "retrieval-pairs.json"), "utf8"),
);
const candidates: Pair[] = JSON.parse(
  fs.readFileSync(path.join(DIR, "retrieval-candidates.json"), "utf8"),
);

/** Words shared between the question and the filename it expects. */
function overlap(question: string, filename: string): number {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2),
    );
  const q = words(question);
  const f = words(filename);
  if (q.size === 0) return 0;
  return [...f].filter((w) => q.has(w)).length / q.size;
}

describe("the graded pairs", () => {
  it("has enough to say anything at all", () => {
    /* Below about a dozen, one question moving is eight points of recall and
       the number stops describing the product. */
    expect(pairs.length).toBeGreaterThanOrEqual(12);
  });

  it("is entirely reviewed", () => {
    /* An unreviewed pair in the graded file is a guess wearing a measurement's
       clothes. Candidates have their own file. */
    for (const p of pairs) expect(p.reviewed).toBe(true);
  });

  /* THE ONE THAT MATTERS MOST. A question that restates its own filename
     cannot be got wrong, so it measures nothing and inflates every score it
     appears in. */
  it("holds no question that is just its own filename", () => {
    const selfAnswering = pairs
      .filter((p) => overlap(p.question, p.expectFilename) > 0.8)
      .map((p) => `"${p.question}" -> "${p.expectFilename}"`);
    expect(selfAnswering).toEqual([]);
  });

  it("asks questions rather than making statements", () => {
    const notQuestions = pairs
      .filter((p) => !/\?/.test(p.question) && !/^(what|who|when|where|which|why|how|list|show|find|the)\b/i.test(p.question.trim()))
      .map((p) => p.question);
    expect(notQuestions).toEqual([]);
  });

  it("names a document for every question", () => {
    for (const p of pairs) {
      expect(p.question.trim().length).toBeGreaterThan(8);
      expect(p.expectFilename.trim().length).toBeGreaterThan(3);
    }
  });

  it("has no duplicate questions", () => {
    const qs = pairs.map((p) => p.question.trim().toLowerCase());
    expect(new Set(qs).size).toBe(qs.length);
  });
});

describe("the candidate queue", () => {
  it("is kept out of the graded set", () => {
    for (const c of candidates) expect(c.reviewed).toBe(false);
    const graded = new Set(pairs.map((p) => p.question.trim().toLowerCase()));
    for (const c of candidates) expect(graded.has(c.question.trim().toLowerCase())).toBe(false);
  });

  /* A queue nobody can review is a queue nobody reviews. Each candidate
     carries the passage its question came from and the answer that passage
     gives, so a decision takes seconds and needs no document opened. */
  it("carries the evidence needed to judge it", () => {
    for (const c of candidates) {
      expect((c.passage ?? "").length).toBeGreaterThan(80);
      expect((c.answer ?? "").length).toBeGreaterThan(10);
    }
  });

  /* THE RULES HAVE TO HAVE RUN. Both the filename rule and the collision rule
     have reported catching nothing on a run where nothing happened to trigger
     them, which reads exactly like a rule that is broken. Asserting the output
     is clean is the check that the generator applied them at all. */
  it("holds nothing the quality rules should have removed", () => {
    for (const c of candidates) {
      expect(namesTheFile(c.question, c.expectFilename)).toBe(false);
    }
    expect(collidingPairs(candidates).size).toBe(0);
  });

  /* One question per document, so a good score cannot come from finding one
     document repeatedly. */
  it("asks about a different document each time", () => {
    const files = candidates.map((c) => c.expectFilename);
    expect(new Set(files).size).toBe(files.length);
  });
});
