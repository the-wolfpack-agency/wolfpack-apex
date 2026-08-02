/**
 * The migration changed no words.
 *
 * Moving a prompt is the one refactor where "it still works" is not observable
 * from the type system or from a passing unit test elsewhere: the model reads
 * the text, so a dropped line is a silent behaviour change that shows up as
 * worse output weeks later. These tests pin the text itself.
 *
 * The auto-acknowledge case is why this file exists. That prompt was a joined
 * ARRAY, and my first pass registered only its opening line. The six hard rules
 * below it are what keep an unsupervised reply from claiming an account is
 * fixed, so losing them would have turned a safe auto-reply into one that
 * asserts things it cannot see — a behaviour change dressed as a migration.
 */
import { renderPrompt } from "../registry";
import { SUPPORT_CATEGORIZE, SUPPORT_AUTO_ACKNOWLEDGE } from "../definitions/support";

describe("support.categorize", () => {
  const text = renderPrompt(SUPPORT_CATEGORIZE, {});

  it("keeps every category the classifier is allowed to choose", () => {
    for (const category of ["m365", "azure", "instinct", "wolfpack-auto", "porsche-classes", "billing", "urgent", "general"]) {
      expect({ category, present: text.includes(`"${category}"`) }).toEqual({ category, present: true });
    }
  });

  it("keeps the rules that shape the output, not just the category list", () => {
    expect(text).toContain('Return ONLY a JSON object');
    expect(text).toContain("confidence is a number from 0.0 to 1.0");
    // The override rule: a breach outranks a better-fitting bucket.
    expect(text).toMatch(/choose "urgent" even if it would also fit another bucket/);
    expect(text).toContain('Output exactly: {"category":"...","confidence":0.0,"reasoning":"..."}');
  });

  it("gains a scope block it did not have before", () => {
    // The one thing the migration ADDS. Everything else must be identical.
    expect(text).toContain("## Scope");
    expect(text).toMatch(/inventing a category that is not listed/);
  });
});

describe("support.auto_acknowledge", () => {
  const text = renderPrompt(SUPPORT_AUTO_ACKNOWLEDGE, {});

  it("keeps all six hard rules, which are the safety of the feature", () => {
    // Numbered explicitly: a count assertion would pass on the wrong six.
    expect(text).toMatch(/1\. Never claim the user's account, license, mailbox, or service is in any specific state/);
    expect(text).toMatch(/2\. Never claim anything has been fixed, resolved, reset, unlocked, or changed/);
    expect(text).toMatch(/3\. Never promise a specific timeline/);
    expect(text).toMatch(/4\. Never invite the customer to reply with credentials/);
    expect(text).toMatch(/5\. Use a warm professional tone\. No em dashes\./);
    expect(text).toMatch(/6\. Output the email body only/);
  });

  it("keeps the output shape instruction", () => {
    expect(text).toContain("no more than 180 words");
    expect(text).toContain("The Wolfpack Team");
  });

  it("states in scope what it may not assert, rather than leaving it implied", () => {
    expect(text).toMatch(/asserting any fact about the user's account state/);
    expect(text).toMatch(/claiming a fix has been or will be performed/);
  });

  it("joins its lines the way the call site joined them", () => {
    // It was `[...].join("\\n")`. A different join collapses the numbered rules
    // onto one line, which reads to a model as one instruction, not six.
    expect(text).toContain("Hard rules:\n1. Never claim");
  });
});

describe("the call sites no longer carry the text", () => {
  it("neither support module still defines the prompt inline", () => {
    const read = (f: string) =>
      require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "..", "support", f), "utf-8");
    for (const f of ["categorizer.ts", "auto-acknowledge.ts"]) {
      // Two copies of a prompt is how they drift, and the drifted one is
      // always the one actually being sent.
      expect({ file: f, inline: /You are (a support-ticket classifier|auto-replying)/.test(read(f)) }).toEqual({
        file: f,
        inline: false,
      });
      expect(read(f)).toContain("renderPrompt(");
    }
  });
});
