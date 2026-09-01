/**
 * Compliance findings.
 *
 * The tests that matter most are the ones asserting we say "could not be
 * established" rather than guessing. A one-click scan that answers pass or fail
 * has to invent a verdict whenever it cannot tell, and an invented verdict on a
 * client report is worse than no report.
 *
 * The other theme: every legal finding must claim PRESENCE, never sufficiency.
 * We can prove a privacy policy is linked. We cannot prove it is adequate, and
 * a report implying we did would be a liability.
 */
import { runComplianceChecks, summarize, contactedThirdParties, type ComplianceInput, type PageFacts, type FindingId } from "../findings";
import type { NetworkObservation } from "../../network/observations";

const PAGE = "https://client.example/";

const facts = (over: Partial<PageFacts> = {}): PageFacts => ({
  links: [
    { href: "https://client.example/privacy", text: "Privacy Policy" },
    { href: "https://client.example/terms", text: "Terms" },
    { href: "https://client.example/contact", text: "Contact" },
  ],
  htmlLang: "en",
  title: "Client Home",
  headers: {
    "content-security-policy": "default-src 'self'",
    "strict-transport-security": "max-age=63072000",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
  },
  pageLoaded: true,
  consentAtMs: 500,
  consentMechanismFound: true,
  ...over,
});

const obs = (over: Partial<NetworkObservation> = {}): NetworkObservation => ({
  url: "https://client.example/app.js",
  pageUrl: PAGE,
  resourceType: "script",
  atMs: 100,
  status: 200,
  ...over,
});

const input = (over: Partial<ComplianceInput> = {}): ComplianceInput => ({
  pageUrl: PAGE,
  facts: facts(),
  observations: [obs()],
  ...over,
});

const get = (i: ComplianceInput, id: FindingId) => runComplianceChecks(i).find((f) => f.id === id)!;

describe("a page that could not be loaded", () => {
  it("reports every check as unverifiable, never as absent", () => {
    // A page we could not load tells us nothing. Reporting "no privacy policy"
    // for it would be a fabrication presented to a client.
    const all = runComplianceChecks(input({ facts: facts({ pageLoaded: false }), observations: [] }));
    for (const f of all) {
      expect({ id: f.id, verdict: f.verdict }).toEqual({ id: f.id, verdict: "unverifiable" });
    }
  });

  it("says so in words a client can read", () => {
    const f = get(input({ facts: facts({ pageLoaded: false }) }), "privacy-policy");
    expect(f.detail).toMatch(/not a statement that it is missing/i);
  });
});

describe("policy findings claim presence, never adequacy", () => {
  it("confirms a linked privacy policy without endorsing its wording", () => {
    const f = get(input(), "privacy-policy");
    expect(f.verdict).toBe("present");
    // The sentence that keeps this out of legal-advice territory.
    expect(f.detail).toMatch(/not a review of whether its wording is right/i);
  });

  it("reports a missing privacy policy as high severity", () => {
    const f = get(input({ facts: facts({ links: [] }) }), "privacy-policy");
    expect(f).toMatchObject({ verdict: "absent", severity: "high" });
  });

  it("finds a policy link by href when the link text does not say so", () => {
    const f = get(input({ facts: facts({ links: [{ href: "/legal/privacy", text: "Legal" }] }) }), "privacy-policy");
    expect(f.verdict).toBe("present");
  });

  it("recognizes policy links in other languages", () => {
    // A client-facing scan that only reads English would report a German site
    // as non-compliant for having an Impressum.
    const de = get(input({ facts: facts({ links: [{ href: "/impressum", text: "Impressum" }] }) }), "terms");
    expect(de.verdict).toBe("present");
    const fr = get(input({ facts: facts({ links: [{ href: "/confidentialite", text: "Confidentialité" }] }) }), "privacy-policy");
    expect(fr.verdict).toBe("present");
  });
});

describe("tracking before consent", () => {
  it("is critical when a tracker fires first", () => {
    const f = get(
      input({ observations: [obs({ url: "https://google-analytics.com/g", atMs: 50 })], facts: facts({ consentAtMs: 1000 }) }),
      "tracking-before-consent",
    );
    expect(f).toMatchObject({ verdict: "absent", severity: "critical" });
    expect(f.detail).toContain("Google Analytics");
  });

  it("names the missing banner as an aggravating fact, not a separate mystery", () => {
    const f = get(
      input({
        observations: [obs({ url: "https://google-analytics.com/g", atMs: 50 })],
        facts: facts({ consentAtMs: null, consentMechanismFound: false }),
      }),
      "tracking-before-consent",
    );
    expect(f.detail).toMatch(/no consent mechanism was found at all/i);
  });

  it("passes when everything waited", () => {
    const f = get(
      input({ observations: [obs({ url: "https://google-analytics.com/g", atMs: 900 })], facts: facts({ consentAtMs: 500 }) }),
      "tracking-before-consent",
    );
    expect(f.verdict).toBe("present");
  });

  it("treats an empty capture as unverifiable, because an empty capture is not an empty page", () => {
    const f = get(input({ observations: [] }), "tracking-before-consent");
    expect(f.verdict).toBe("unverifiable");
    expect(f.detail).toMatch(/not an empty page/i);
  });
});

describe("data residency", () => {
  it("does not claim compliance when no requirement was stated", () => {
    // The tempting output is "present". Nobody told us the rule, so we cannot
    // say it is met, and telling a client it is would be inventing a pass.
    const f = get(input(), "data-residency");
    expect(f.verdict).toBe("unverifiable");
    expect(f.detail).toMatch(/no permitted countries were configured/i);
  });

  it("flags a third party served from outside the permitted countries", () => {
    const f = get(
      input({ observations: [obs({ url: "https://tracker.test/x", serverCountry: "US" })], permittedCountries: ["DE", "IE"] }),
      "data-residency",
    );
    expect(f).toMatchObject({ verdict: "absent", severity: "high" });
    expect(f.detail).toContain("tracker.test (US)");
  });

  it("reports an unlocatable host as a gap rather than a pass", () => {
    const f = get(input({ observations: [obs({ url: "https://tracker.test/x" })], permittedCountries: ["DE"] }), "data-residency");
    expect(f.verdict).toBe("unverifiable");
    expect(f.detail).toMatch(/gap rather than a pass/i);
  });

  it("passes only when every party is inside the permitted set", () => {
    const f = get(
      input({ observations: [obs({ url: "https://tracker.test/x", serverCountry: "DE" })], permittedCountries: ["DE"] }),
      "data-residency",
    );
    expect(f.verdict).toBe("present");
  });
});

describe("accessibility and hygiene", () => {
  it("flags a missing language declaration with the reason it matters", () => {
    const f = get(input({ facts: facts({ htmlLang: null }) }), "accessibility-language");
    expect(f.verdict).toBe("absent");
    expect(f.detail).toMatch(/screen readers/i);
  });

  it("flags an empty title, including one that is only whitespace", () => {
    expect(get(input({ facts: facts({ title: "   " }) }), "accessibility-title").verdict).toBe("absent");
  });

  it("raises severity when the missing header is the content security policy", () => {
    const noCsp = facts({ headers: { "strict-transport-security": "x", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
    expect(get(input({ facts: noCsp }), "security-headers")).toMatchObject({ verdict: "absent", severity: "high" });
  });

  it("treats absent headers as unverifiable when none were captured at all", () => {
    // No headers captured means we did not look, not that none are set.
    expect(get(input({ facts: facts({ headers: {} }) }), "security-headers").verdict).toBe("unverifiable");
  });

  it("accepts a mailto link as a contact route", () => {
    const f = get(input({ facts: facts({ links: [{ href: "mailto:hi@client.example", text: "Say hello" }] }) }), "contact-route");
    expect(f.verdict).toBe("present");
  });
});

describe("ordering and summary", () => {
  it("puts the most serious issue first, so a client reads it first", () => {
    const all = runComplianceChecks(
      input({ facts: facts({ links: [], consentAtMs: null, consentMechanismFound: false }), observations: [obs({ url: "https://google-analytics.com/g", atMs: 10 })] }),
    );
    expect(all[0].severity).toBe("critical");
    expect(all[0].id).toBe("tracking-before-consent");
  });

  it("does not let an unverifiable finding set the worst-issue level", () => {
    // Not knowing is not the same as knowing it is wrong. Conflating them makes
    // the report cry wolf and trains people to ignore it.
    const s = summarize(runComplianceChecks(input()));
    expect(s.unverifiable).toBeGreaterThan(0);
    expect(s.worstAbsent).toBeNull();
  });

  it("counts each verdict and says so in one line", () => {
    const s = summarize(runComplianceChecks(input({ facts: facts({ links: [] }) })));
    expect(s.total).toBe(s.present + s.absent + s.unverifiable);
    expect(s.headline).toMatch(/issue/);
  });

  it("reports a fully clean page without hedging", () => {
    const s = summarize(
      runComplianceChecks(
        input({ observations: [obs({ url: "https://tracker.test/x", serverCountry: "DE", atMs: 900 })], permittedCountries: ["DE"] }),
      ),
    );
    expect(s.absent).toBe(0);
    expect(s.headline).toMatch(/All \d+ checks passed/);
  });
});

describe("the appendix", () => {
  it("lists every third party so a client can see the list, not just the findings", () => {
    const list = contactedThirdParties([obs({ url: "https://google-analytics.com/g" }), obs({ url: "https://client.example/a.js" })]);
    expect(list.map((c) => c.host)).toEqual(["google-analytics.com"]);
    expect(list[0].vendor).toBe("Google Analytics");
  });
});
