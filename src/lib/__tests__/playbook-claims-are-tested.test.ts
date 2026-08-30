/**
 * The playbook is handed to clients, so its claims must be controls.
 *
 * WHY THIS EXISTS. On 2026-08-30 the playbook already said "If a system is
 * unavailable, the answer says so. It does not invent one." It was not true.
 * With the model provider unreachable the product replied "I don't have
 * information on that yet. You can help me learn by adding it to the Knowledge
 * Base" about a document it was holding, which is the opposite of saying so.
 *
 * The sentence was written in good faith and nothing contradicted it, because
 * nobody had ever run the product with a dependency down. A claim in a
 * client-facing document with no check behind it is the same defect as a metric
 * with no check behind it: it reads as evidence and is a hope.
 *
 * So each claim asserted here is tied to the thing that proves it. This cannot
 * verify prose in general, and does not pretend to. It pins the specific
 * promises that were made before they were true.
 */

import { CLIENT_DEPLOYMENT_PLAYBOOK, PLAYBOOK_UPDATED } from "@/lib/playbook";
import { existsSync } from "node:fs";
import { degradedAnswer } from "@/lib/assistant/degraded-answer";
import { isRetryableError } from "@/lib/ai/router";

describe("what the playbook promises, the product does", () => {
  /* CLAIM: an outage says what could not be read and that nothing was lost. */
  it("the outage promise matches the words a person is actually shown", () => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(/nothing has been lost and nothing needs\s+re-uploading/);

    const shown = degradedAnswer([{ kind: "model" }])!.text;
    expect(shown).toMatch(/nothing has been lost/i);
    expect(shown).toMatch(/nothing needs re-uploading/i);
    /* And never the sentence that caused the correction. */
    expect(shown).not.toMatch(/add(ing)? it to the Knowledge Base/i);
  });

  /* CLAIM: a brief failure is retried before anybody sees it. */
  it("the retry promise matches what the router treats as retryable", () => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(/brief failure is retried/i);
    /* The two named in the sentence: throttles and connection blips. */
    expect(isRetryableError({ status: 429 })).toBe(true);
    expect(isRetryableError({ code: "ECONNREFUSED" })).toBe(true);
  });

  /* CLAIM: the outage probe runs before a phase ships. A command named in a
     client document must exist, or the promise is unrunnable. */
  it("every script the verification table names exists", () => {
    const table = CLIENT_DEPLOYMENT_PLAYBOOK.slice(
      CLIENT_DEPLOYMENT_PLAYBOOK.indexOf("## What is verified before every phase ships"),
    );
    const scripts = [...table.matchAll(/`(scripts\/[a-z0-9.\-/]+)`/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(`${script}: ${existsSync(script)}`).toBe(`${script}: true`);
    }
    expect(scripts).toContain("scripts/probe-outage.sh");
  });

  /* The correction itself is recorded rather than quietly fixed. A client who
     read the earlier version deserves the page to say what changed. */
  it("says plainly that the outage promise was aspirational until it was not", () => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(/aspirational until/i);
  });

  it("carries a date that moved when the document did", () => {
    expect(PLAYBOOK_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(PLAYBOOK_UPDATED >= "2026-08-30").toBe(true);
  });
});

/**
 * WHAT WE ASK A CLIENT FOR IS A PROMISE ABOUT WHAT WE WILL SEE.
 *
 * The playbook now asks for a Copilot usage export. Microsoft offers two
 * Copilot surfaces and they sit on opposite sides of the line this product
 * sells on:
 *
 *   getMicrosoft365CopilotUsageUserDetail   counts and dates, no content
 *   getAllEnterpriseInteractions            full prompts and replies
 *
 * The second is exactly what the gist argument says to refuse, and refusing it
 * is the pitch rather than a limitation. If somebody later "improves" the
 * playbook by asking for richer data, this fails: a document that quietly
 * starts asking for prompt text has changed what we are, not what we collect.
 */
describe("the Copilot ask stays on the safe side of the line", () => {
  it("asks for the usage export", () => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(/Copilot usage/i);
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(/CSV export/i);
  });

  /* THE ONE THAT MATTERS. Says out loud that no prompt or response text is
     involved, because a client will ask and the answer must be in writing. */
  it("states that it carries no prompt or response text", () => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(/No prompt text and no\s+response text/i);
  });

  it("says we deliberately do not ask for the interaction API", () => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(/deliberately do not ask for it/i);
  });

  /* An export needs no consent grant; the API needs tenant-wide admin consent.
     Bundling the second into the Phase 1 grant is the mistake this guards. */
  it("asks for the export rather than the scope, and explains why", () => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(/Reports\.Read\.All/);
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(/tenant-wide admin\s+consent/i);
  });

  /* The limitation that would otherwise disappoint somebody later. */
  it("separates adoption data from decision data", () => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(/adoption data, not decision data/i);
  });

  /* And never promises the thing it cannot deliver. */
  it("does not claim the export shows what Copilot changed", () => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).not.toMatch(/getAllEnterpriseInteractions/);
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).not.toMatch(/AiEnterpriseInteraction/);
  });
});
