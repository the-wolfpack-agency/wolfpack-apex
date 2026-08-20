/**
 * Repo-wide ratchet: untrusted content must not reach a code-emitting path.
 *
 * This generalises a bug that was real and shipped. wolfpack-site-template's
 * scaffolder built JSX SOURCE by interpolating brief copy — copy that comes
 * from an AI wireframe extraction and from an operator typing — with an escaper
 * that handled backticks and `$` and nothing else. Brief text could close an
 * element and inject a script, or open a JSX expression and render a build-time
 * env var into a public page.
 *
 * The class is broader than that one file: anywhere this repo BUILDS code or a
 * prompt out of text it did not author, the same mistake is available. The
 * general fix is not a better escaper, it is never emitting untrusted text as
 * syntax — put it inside a string literal, where a `<` cannot open an element
 * and a `{` cannot open an expression.
 *
 * So this test enumerates the places that generate code. Like prompt-coverage
 * and provider-coverage, the list may shrink and never grow: a new generator
 * fails the build until someone decides how it handles untrusted text.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..", "..");

/**
 * Signatures of building code from a template literal. Narrow on purpose: a
 * broad heuristic catches ordinary string building, goes noisy, and gets
 * disabled — which is how a guardrail dies.
 */
const EMITS_JSX = /`[^`]*<[a-zA-Z][^`]*\$\{/;

/**
 * Files that build markup or code from a template literal and have NOT been
 * audited for untrusted input.
 *
 * This list is DEBT, not approval. Naming it "reviewed" would have been the
 * same move this whole session has been arguing against: asserting a property
 * nobody measured. Fifteen files build markup this way; auditing each one means
 * tracing every interpolated value back to where it came from, and doing that
 * badly is worse than not claiming it.
 *
 * The ratchet is what makes it useful now. A NEW generator fails the build, so
 * the surface cannot grow while the audit is outstanding. Auditing one means
 * deleting its line — and if it turns out to need the fix, applying the same
 * one wolfpack-site-template PR #1 used: emit untrusted values as JSON string
 * literals rather than as syntax.
 *
 * Highest risk first, by inspection of what feeds them: report-templates,
 * site-forms and brand-url-import all carry text that originates outside this
 * system.
 */
const UNAUDITED_GENERATORS: readonly string[] = [
  "lib/brand-url-import.ts",
  "lib/compliance/export.ts",
  "lib/integrations/microsoft-onenote.ts",
  "lib/principles/sharepoint-write.ts",
  "lib/programs/budget-xlsx.ts",
  "lib/site-forms.ts",
];

/**
 * Audited, with what was found. An entry here is a claim someone checked, so
 * each records the evidence rather than a verdict.
 */
const AUDITED: Readonly<Record<string, string>> = {
  "lib/ai/provenance.ts":
    "SAFE, and the interpolation is the point: this file EXISTS to wrap untrusted text in a fence, so it necessarily builds markup around text from outside. Two breakouts are possible and both are closed and tested. The body has every <untrusted> tag replaced before it is placed, so content cannot close its own fence and write outside it; the test counts the closing tags and asserts one. The label is stripped of < > and \" and truncated, so it cannot end its attribute; the test feeds it a label crafted to open a second tag and asserts only one exists. Emitting as a JSON string literal is not available here: the model has to READ this, so it has to be text.",
  "lib/markdown.ts":
    "SAFE, verified by running it: escaping happens before inline formatting, so a quote in a link target arrives as &quot; and stays inside the attribute value. Hypothesised an attribute breakout, tested it, and was wrong.",
  "lib/mail/send-invite.ts": "FIXED: href was raw while the same URL was escaped for display. Not exploitable (base is env, not a request header) but the inconsistency was the tell.",
  "lib/mail/send-password-reset.ts": "FIXED: same raw href as send-invite; the reset URL was escaped for display and emitted bare inside the anchor.",
  "lib/agents/invite-email.ts": "FIXED: same raw href as send-invite; the agent activation URL was escaped for display and emitted bare inside the anchor.",
  "lib/dev/branch-base.ts": "SAFE: builds console output, not markup; the detector matched a '<' in a plain string.",
  "lib/report-templates.ts":
    "FIXED, found by running it (generator-injection.test.ts): the markdown link URL landed inside href=\"...\" and the escaper handled & < > but NOT the quote, so `[click](\" onmouseover=\"alert(1))` rendered a live handler. Now scheme-allow-listed (javascript:/data: become #) and quote-encoded. Body text was already escape-first and safe.",
  "lib/qr/svg.ts":
    "SAFE, verified by running it: the input is encoded into QR modules and never interpolated into the document, so hostile text does not appear in the output at all.",
  "lib/favicon-generator.ts":
    "SAFE, verified by running it: resolveMonogram strips to alphanumerics before it reaches the SVG, and a colour that is not a colour is replaced with a default rather than interpolated into the fill attribute.",
  "lib/html-sanitize.ts": "SAFE: this IS the sanitizer. Its template wraps input for DOMPurify to parse, which is the point.",
};

function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__" || entry.startsWith(".")) continue;
    const abs = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(abs).isDirectory()) {
      out.push(...walk(abs, rel));
      continue;
    }
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

describe("untrusted content never becomes syntax", () => {
  const candidates = walk(join(SRC, "lib"), "lib").filter((rel) => {
    const source = readFileSync(join(SRC, rel), "utf-8");
    return EMITS_JSX.test(source);
  });

  it("no NEW file builds markup from a template literal", () => {
    // The ratchet. A new generator is the moment to decide how it handles
    // untrusted text; adding one silently is what this prevents.
    const covered = [...UNAUDITED_GENERATORS, ...Object.keys(AUDITED)];
    const unlisted = candidates.filter((f) => !covered.includes(f));
    expect(
      unlisted.map(
        (f) =>
          `${f} builds markup/code from a template literal. If any interpolated value is model output or text from outside this system, emit it as a JSON string literal (see wolfpack-site-template PR #1) rather than as syntax.`,
      ),
    ).toEqual([]);
  });

  it("has no stale entry, so the debt cannot be overstated", () => {
    // A list that never shrinks reads as progress that never happened.
    const stale = [...UNAUDITED_GENERATORS, ...Object.keys(AUDITED)].filter((f) => !candidates.includes(f));
    expect(stale.map((f) => `${f} no longer emits markup — remove it from UNAUDITED_GENERATORS`)).toEqual([]);
  });

  it("records the outstanding audit as a number, so the trend is visible", () => {
    // 15 -> 9 -> 6. Update deliberately; the direction is the point.
    // The 9 -> 6 pass audited by EXECUTION, not by reading, and found one real
    // injection in report-templates.
    expect(UNAUDITED_GENERATORS.length).toBe(6);
  });

  it("counts an audited file as covered, and keeps its evidence", () => {
    // Audited and unaudited together must cover everything the detector finds,
    // or a file has quietly fallen off both lists.
    const covered = [...UNAUDITED_GENERATORS, ...Object.keys(AUDITED)].sort();
    expect(candidates.filter((c) => !covered.includes(c))).toEqual([]);
    for (const [file, evidence] of Object.entries(AUDITED)) {
      // "safe" on its own is a verdict. The evidence is what makes it checkable.
      expect({ file, ok: evidence.length > 60 }).toEqual({ file, ok: true });
    }
  });
});

describe("the safe-emitter pattern is documented where it is needed", () => {
  it("the containment plan records why an escaper is the wrong fix", () => {
    // The plan is the thing a future session reads before touching a
    // generator. If the reasoning is not in the repo, it is not a control.
    const plan = readFileSync(join(SRC, "..", "docs", "plans", "2026-08-autonomous-build-and-containment.md"), "utf-8");
    expect(plan).toMatch(/untrusted/i);
    expect(plan).toMatch(/Tainted|becomes code|code-emitting/i);
  });
});
