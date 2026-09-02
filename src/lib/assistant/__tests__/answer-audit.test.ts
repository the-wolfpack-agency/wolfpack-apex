/** @jest-environment node */
/**
 * The answer-hygiene detectors, keyed on the real thing that leaked.
 *
 * Every leak case here is taken from the morning brief a person actually saw:
 * "Meeting ID: AAMkAG...", 'cache status is "miss"'. The routing audit passed
 * that prompt because routing was fine. These detectors are what catches the
 * answer, and the boundary tests matter as much as the hits: a guardrail that
 * fires on ordinary prose is one somebody switches off.
 */

import { auditAnswer, BLOAT_CHARS } from "../answer-audit";

describe("catches the leak that shipped", () => {
  it("flags a Microsoft Graph meeting id narrated into prose", () => {
    const a = auditAnswer("Prepare for your next meeting (Meeting ID: AAMkAGVmZjEwMTM3LWRlYWQ=).");
    expect(a.clean).toBe(false);
    expect(a.findings.some((f) => f.kind === "opaque_id")).toBe(true);
  });

  it('flags a raw cache field, the "cache status is miss" leak', () => {
    const a = auditAnswer('The brief for the next meeting shows cache status is "miss".');
    expect(a.clean).toBe(false);
    expect(a.findings.some((f) => f.kind === "cache_field")).toBe(true);
  });

  it("flags an unfilled routine slot", () => {
    const a = auditAnswer("Here is your inbox: {{the_overnight_email}}");
    expect(a.clean).toBe(false);
    expect(a.findings.some((f) => f.kind === "unfilled_slot")).toBe(true);
  });

  it("flags a transport cursor or nextLink", () => {
    expect(auditAnswer("more at @odata.nextLink").clean).toBe(false);
    expect(auditAnswer("etag: W/\"abc\"").clean).toBe(false);
  });

  it("flags a generic opaque token even without the Graph prefix", () => {
    const a = auditAnswer("reference dGhpc2lzYXZlcnlsb25nb3BhcXVldG9rZW5ub2JvZHl0eXBlcw==");
    expect(a.clean).toBe(false);
    expect(a.findings.some((f) => f.kind === "opaque_id")).toBe(true);
  });
});

describe("does not fire on ordinary prose", () => {
  /* THE BOUNDARY. Each of these mentions a leaky concept in words a person
     would really write, and none of them is a leak. */
  it("lets a natural sentence about a meeting through", () => {
    const a = auditAnswer("Your 10am with Dana is about Q3 planning; the invite has the dial-in.");
    expect(a.clean).toBe(true);
    expect(a.findings.filter((f) => f.severity === "leak")).toEqual([]);
  });

  it("does not treat the words 'id' or 'cache' in prose as a leak", () => {
    expect(auditAnswer("I did not cache that, so it may be a moment.").clean).toBe(true);
    expect(auditAnswer("The meeting id is printed on the paper invite.").clean).toBe(true);
  });

  it("does not flag a normal long word or a hyphenated name", () => {
    expect(auditAnswer("This is an extraordinarily comprehensive counterproposal.").clean).toBe(true);
    expect(auditAnswer("Contact Mary-Anne Featherstone-Willoughby about it.").clean).toBe(true);
  });

  /* THE FALSE POSITIVE THE HARNESS CAUGHT ITSELF. A URL path in legitimate
     retrieved document content is not a leak, and the first detector flagged
     it because it allowed "/" and did not require a digit. */
  it("does not flag a URL path in legitimate document content", () => {
    const real = "See the disclosure at /mastrosthousandoaks/ConsumerDisclosure/ | Privacy";
    expect(auditAnswer(real).clean).toBe(true);
  });

  it("does not flag a long readable camelCase or path run with no digits", () => {
    expect(auditAnswer("ConsumerDisclosureAndPrivacyPolicyAcknowledgement").clean).toBe(true);
    expect(auditAnswer("folder/subfolder/AnotherFolder/DocumentTitleHere").clean).toBe(true);
  });

  it("counts a single opaque leak once, not twice", () => {
    const a = auditAnswer("id AAMkAGVmZjEwMTM3LWRlYWRiZWVmY2FmZQ==");
    expect(a.findings.filter((f) => f.kind === "opaque_id")).toHaveLength(1);
  });
});

describe("reports bloat and empty without calling them leaks", () => {
  it("warns on an essay but does not mark it a leak", () => {
    const a = auditAnswer("word ".repeat(Math.ceil(BLOAT_CHARS / 5) + 10));
    expect(a.clean).toBe(true); // bloat is a warning, not a leak
    expect(a.findings.some((f) => f.kind === "bloat")).toBe(true);
  });

  it("warns on an empty or object-shaped answer", () => {
    expect(auditAnswer("").findings.some((f) => f.kind === "empty")).toBe(true);
    expect(auditAnswer("[object Object]").findings.some((f) => f.kind === "empty")).toBe(true);
  });

  it("says a terse real answer is clean", () => {
    const a = auditAnswer("Two meetings today, both after lunch. Nothing needs you before then.");
    expect(a.clean).toBe(true);
    expect(a.findings).toEqual([]);
  });
});
