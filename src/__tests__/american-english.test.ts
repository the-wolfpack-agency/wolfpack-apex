/**
 * The client is in North America, so the product spells like it.
 *
 * A one-time sweep fixes the words that are there today and nothing about the
 * words somebody writes next week. Spelling drift is invisible in review: no
 * test fails, nothing looks wrong to whoever wrote it, and it surfaces when a
 * client reads "programme" on a page about their own training program.
 *
 * WHAT IS DELIBERATELY NOT CHECKED, AND WHY EACH ONE MATTERS.
 *
 * "cancelled" is absent from the list. isCancelled is a Microsoft Graph field
 * and hr.onboarding_cancelled is an analytics event name. Those are data, not
 * wording: renaming them breaks a contract with an outside system and orphans
 * every historical row. The spelling of a field we do not own is not ours to
 * correct.
 *
 * "analysis" and "analyses" are correct in American English. Only the verb
 * forms move, so the list carries analyse, analysed and analysing and stops
 * there. A rule that converted the noun would invent words.
 *
 * WHAT SOMEBODY TYPED IS NEVER REWRITTEN. Queries quoted back on the pilot
 * page are a record of what a person asked. Correcting their spelling would
 * make the panel misreport its own evidence, which is a worse failure than an
 * inconsistent page. This checks what WE write.
 */

import fs from "node:fs";
import path from "node:path";

const ROOTS = ["src", "scripts", "docs", "tests", ".github"];
const EXTENSIONS = new Set([".ts", ".tsx", ".md", ".css", ".sql", ".yml", ".yaml"]);

/** Stem to preferred spelling. One entry covers every inflection. */
const PREFER: Array<[RegExp, string]> = [
  [/\\bsummaris(e|es|ed|ing|ation|ations|able)\\b/gi, "summariz"],
  [/\\borganis(e|es|ed|ing|ation|ations|able)\\b/gi, "organiz"],
  [/\bprogramme/gi, "program"],
  [/\bbehaviour/gi, "behavior"],
  [/\bcentre/gi, "center"],
  [/\bcolour/gi, "color"],
  [/\bfavour/gi, "favor"],
  [/\bcatalogue/gi, "catalog"],
  [/\bjudgement/gi, "judgment"],
  [/\\bprioritis(e|es|ed|ing|ation|ations|able)\\b/gi, "prioritiz"],
  /* Verb forms only: "optimistic" and "optimism" are correct. */
  [/\boptimis(e|ed|es|ing|ation|ations)\b/gi, "optimiz"],
  [/\\brecognis(e|es|ed|ing|ation|ations|able)\\b/gi, "recogniz"],
  [/\brealis(e|ed|ing|es)\b/gi, "realiz-"],
  [/\\bauthoris(e|es|ed|ing|ation|ations|able)\\b/gi, "authoriz"],
  [/\\butilis(e|es|ed|ing|ation|ations|able)\\b/gi, "utiliz"],
  [/\\bnormalis(e|es|ed|ing|ation|ations|able)\\b/gi, "normaliz"],
  [/\\binitialis(e|es|ed|ing|ation|ations|able)\\b/gi, "initializ"],
  [/\\bspecialis(e|es|ed|ing|ation|ations|able)\\b/gi, "specializ"],
  [/\\bstandardis(e|es|ed|ing|ation|ations|able)\\b/gi, "standardiz"],
  [/\\bcustomis(e|es|ed|ing|ation|ations|able)\\b/gi, "customiz"],
  [/\\bminimis(e|es|ed|ing|ation|ations|able)\\b/gi, "minimiz"],
  [/\\bmaximis(e|es|ed|ing|ation|ations|able)\\b/gi, "maximiz"],
  [/\\bapologis(e|es|ed|ing|ation|ations|able)\\b/gi, "apologiz"],
  [/\\bpersonalis(e|es|ed|ing|ation|ations|able)\\b/gi, "personaliz"],
  [/\blabelled/gi, "labeled"],
  [/\blabelling/gi, "labeling"],
  [/\bmodelling/gi, "modeling"],
  [/\btravelled/gi, "traveled"],
  [/\bdefence/gi, "defense"],
  [/\blicence/gi, "license"],
  [/\bwhilst/gi, "while"],
  [/\bamongst/gi, "among"],
  [/\blearnt/gi, "learned"],
  [/\bpractise/gi, "practice"],
  [/\benrolment/gi, "enrollment"],
  /* Verb forms only. The noun is spelled the same on both sides. */
  [/\banalyse\b/gi, "analyze"],
  [/\banalysed\b/gi, "analyzed"],
  [/\banalysing\b/gi, "analyzing"],
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

/**
 * Places that must accept a spelling we do not use ourselves.
 *
 * Both are inputs, not output: they match what a PERSON typed, and a person
 * types whatever they type. Narrowing them to American spelling would silently
 * stop recognising half the people who ask, which is a functional regression
 * dressed as a style fix.
 */
const ACCEPTS_WHAT_USERS_TYPE: Record<string, string> = {
  "src/lib/pilot/wanted-actions.ts":
    "maps typed verbs to actions; both spellings of organise must match",
  "src/lib/assistant/tools/schedule-health-tool.ts":
    "intent regex; both spellings of analyse must trigger the tool",
};

describe("spelling", () => {
  const files = ROOTS.filter((r) => fs.existsSync(path.join(process.cwd(), r))).flatMap((r) =>
    walk(path.join(process.cwd(), r)),
  );

  it("is American throughout, including filenames", () => {
    const found: string[] = [];

    for (const file of files) {
      const rel = path.relative(process.cwd(), file);
      /* This file names every word it forbids, so it would fail itself. */
      if (rel.endsWith("american-english.test.ts")) continue;

      if (rel in ACCEPTS_WHAT_USERS_TYPE) continue;

      const text = fs.readFileSync(file, "utf8");
      for (const [pattern, preferred] of PREFER) {
        const hits = text.match(pattern);
        if (hits) found.push(`${rel}: "${hits[0]}" -> "${preferred}"`);
        /* A filename carries the same weight: an import of ./catalogue reads
           as ours whichever way the file spells it inside. */
        if (pattern.test(rel)) found.push(`${rel}: filename -> "${preferred}"`);
        pattern.lastIndex = 0;
      }
    }

    expect(found.slice(0, 25).join("\n")).toBe("");
  });

  /* WORDS A BARE STEM WOULD EAT, AND DID.
   *
   * The first version of this list used stems like /\brealis/ and
   * /\boptimis/, which match "realistic", "realism", "optimistic" and
   * "specialist" too. Those are correct in both variants, and the sweep
   * rewrote them into realiztic, realizm, optimiztic and specializt across 85
   * files before anyone read the output.
   *
   * Every stem is bound to a British ending now, and these are the words that
   * prove it. */
  it("leaves alone the words that are correct in both variants", () => {
    const safe = [
      "realistic expectations",
      "a realism about the numbers",
      "optimistic forecast",
      "the specialist team",
      "organism",
      "analysis of the data",
      "the analyses agree",
      "isCancelled",
      "a cancelled meeting",
    ];
    for (const phrase of safe) {
      const hit = PREFER.find(([p]) => {
        p.lastIndex = 0;
        return p.test(phrase);
      });
      expect(hit ? `${phrase} -> flagged by ${hit[0]}` : "").toBe("");
    }
  });

  /* The list is the whole test, so a change that stopped it matching would
     pass silently and guard nothing. */
  it("has a working list", () => {
    expect(/\bprogramme/i.test("the programme runs")).toBe(true);
    expect(/\bcentre/i.test("the centre")).toBe(true);
    /* And the bound stems still catch the real thing. */
    const realis = PREFER.find(([p]) => String(p).includes("realis"))![0];
    realis.lastIndex = 0;
    expect(realis.test("we realised late")).toBe(true);
    /* And does not flag the words that are correct here. */
    expect(/\banalyse\b/i.test("the analysis of the data")).toBe(false);
    expect(PREFER.some(([p]) => p.test("isCancelled"))).toBe(false);
  });
});
