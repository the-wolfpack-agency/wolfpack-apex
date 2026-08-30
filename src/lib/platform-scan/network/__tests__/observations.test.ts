/**
 * The shared observation layer that compliance and anomaly detection both read.
 *
 * The cases that carry weight are the ones about NOT knowing: a host we cannot
 * identify, a country we could not resolve, a site with no consent banner at
 * all. Each is a place where the convenient answer (treat it as fine) would
 * report compliance nobody established.
 */
import {
  capabilityNote,
  classify,
  partyOf,
  identify,
  hostOf,
  rootDomain,
  thirdParties,
  firedBeforeConsent,
  outsideJurisdiction,
  unexplained,
  type NetworkObservation,
} from "../observations";

const PAGE = "https://client.example/";
const req = (over: Partial<NetworkObservation> = {}): NetworkObservation => ({
  url: "https://client.example/app.js",
  pageUrl: PAGE,
  resourceType: "script",
  atMs: 100,
  status: 200,
  ...over,
});

describe("partyOf", () => {
  it("separates first-party, subdomain and third-party", () => {
    expect(partyOf("https://client.example/a.js", PAGE)).toBe("first-party");
    expect(partyOf("https://cdn.client.example/a.js", PAGE)).toBe("subdomain");
    expect(partyOf("https://google-analytics.com/g", PAGE)).toBe("third-party");
  });

  it("treats an unparseable URL as third-party rather than trusting it", () => {
    expect(partyOf("not a url", PAGE)).toBe("third-party");
  });

  it("ignores a www prefix, which is the same party by any reasonable reading", () => {
    expect(partyOf("https://www.client.example/a", PAGE)).toBe("first-party");
  });
});

describe("identify", () => {
  it("names vendors it is sure about", () => {
    expect(identify("https://www.google-analytics.com/g/collect")).toEqual({ kind: "analytics", name: "Google Analytics" });
    expect(identify("https://static.hotjar.com/c/hotjar.js").kind).toBe("session-replay");
  });

  it("refuses a lookalike host", () => {
    // "evil-hotjar.com".endsWith("hotjar.com") is true. Only a dot boundary counts.
    expect(identify("https://evil-hotjar.com/x").name).toBeNull();
    expect(identify("https://hotjar.com.evil.test/x").name).toBeNull();
  });

  it("returns unknown rather than guessing", () => {
    // Precision-first: a short list we are sure about beats a long one that
    // cries wolf. Unknown is a prompt to look, not an accusation.
    expect(identify("https://some-vendor.test/px")).toEqual({ kind: "unknown", name: null });
  });
});

describe("rootDomain", () => {
  it("reduces to the last two labels", () => {
    expect(rootDomain("a.b.client.example")).toBe("client.example");
    expect(rootDomain("client.example")).toBe("client.example");
  });
});

describe("thirdParties", () => {
  it("keeps one entry per host, at its EARLIEST contact", () => {
    // The downstream question is "did this fire before consent", and only the
    // first occurrence answers it.
    const out = thirdParties([
      req({ url: "https://google-analytics.com/g", atMs: 900 }),
      req({ url: "https://google-analytics.com/g2", atMs: 300 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].atMs).toBe(300);
  });

  it("excludes first-party and subdomain requests", () => {
    expect(
      thirdParties([req(), req({ url: "https://cdn.client.example/a.js" })]),
    ).toEqual([]);
  });

  it("returns them in the order they first fired", () => {
    const out = thirdParties([
      req({ url: "https://hotjar.com/a", atMs: 500 }),
      req({ url: "https://mixpanel.com/a", atMs: 200 }),
    ]);
    expect(out.map((c) => c.host)).toEqual(["mixpanel.com", "hotjar.com"]);
  });
});

describe("firedBeforeConsent", () => {
  it("reports trackers that fired before the banner was accepted", () => {
    const out = firedBeforeConsent(
      [req({ url: "https://google-analytics.com/g", atMs: 200 }), req({ url: "https://mixpanel.com/t", atMs: 5000 })],
      1000,
    );
    expect(out.map((c) => c.host)).toEqual(["google-analytics.com"]);
  });

  it("treats NO consent mechanism as everything firing without consent", () => {
    // The convenient reading is "no banner, nothing to check". The honest one
    // is that with no banner, nothing was consented to.
    const out = firedBeforeConsent([req({ url: "https://google-analytics.com/g", atMs: 200 })], null);
    expect(out).toHaveLength(1);
  });

  it("does not flag a CDN, because loading a stylesheet is not tracking", () => {
    // A report that flags every font file trains people to skim past it.
    const out = firedBeforeConsent([req({ url: "https://cdn.jsdelivr.net/x.css", atMs: 10 })], null);
    expect(out).toEqual([]);
  });

  it("flags an unrecognised host, since unknown is not the same as harmless", () => {
    const out = firedBeforeConsent([req({ url: "https://who-is-this.test/px", atMs: 10 })], null);
    expect(out.map((c) => c.host)).toEqual(["who-is-this.test"]);
  });
});

describe("outsideJurisdiction", () => {
  it("separates hosts outside the permitted set from hosts it could not resolve", () => {
    const { outside, unknown } = outsideJurisdiction(
      [
        req({ url: "https://a.test/x", serverCountry: "US" }),
        req({ url: "https://b.test/x", serverCountry: "DE" }),
        req({ url: "https://c.test/x", serverCountry: null }),
      ],
      ["DE", "FR", "IE"],
    );
    expect(outside.map((c) => c.host)).toEqual(["a.test"]);
    expect(unknown.map((c) => c.host)).toEqual(["c.test"]);
  });

  it("never silently drops a host whose country is unknown", () => {
    // "We could not tell where this goes" is a finding on a site with a
    // residency obligation. Dropping it reports compliance nobody established.
    const { outside, unknown } = outsideJurisdiction([req({ url: "https://x.test/a" })], ["DE"]);
    expect(outside).toEqual([]);
    expect(unknown).toHaveLength(1);
  });

  it("compares countries case-insensitively", () => {
    const { outside } = outsideJurisdiction([req({ url: "https://a.test/x", serverCountry: "de" })], ["DE"]);
    expect(outside).toEqual([]);
  });
});

describe("unexplained", () => {
  it("returns hosts nothing in the site accounts for", () => {
    const out = unexplained(
      [req({ url: "https://google-analytics.com/g" }), req({ url: "https://mystery.test/px" })],
      ["google-analytics.com"],
    );
    expect(out.map((c) => c.host)).toEqual(["mystery.test"]);
  });

  it("counts a subdomain of a declared host as explained", () => {
    expect(unexplained([req({ url: "https://eu.segment.io/v1" })], ["segment.io"])).toEqual([]);
  });

  it("does not let a lookalike pass as declared", () => {
    const out = unexplained([req({ url: "https://evil-segment.io/v1" })], ["segment.io"]);
    expect(out.map((c) => c.host)).toEqual(["evil-segment.io"]);
  });

  it("reports everything when nothing is declared, rather than nothing", () => {
    // An empty manifest means the system can explain none of it. That is the
    // maximum-signal state, not the minimum.
    const out = unexplained([req({ url: "https://a.test/x" }), req({ url: "https://b.test/x" })], []);
    expect(out).toHaveLength(2);
  });
});

describe("one observation set, three questions", () => {
  it("lets a single request be a consent, sovereignty and anomaly finding at once", () => {
    // This is why the layer is shared. Three detectors reading one set of
    // observations is what makes the cross-referenced sentence possible:
    // "a tracker appeared that nothing explains, it fired before consent, and
    // it resolves outside the client's jurisdiction".
    const observations = [req({ url: "https://mystery-tracker.test/px", atMs: 120, serverCountry: "US" })];

    expect(firedBeforeConsent(observations, 3000).map((c) => c.host)).toEqual(["mystery-tracker.test"]);
    expect(outsideJurisdiction(observations, ["DE"]).outside.map((c) => c.host)).toEqual(["mystery-tracker.test"]);
    expect(unexplained(observations, ["google-analytics.com"]).map((c) => c.host)).toEqual(["mystery-tracker.test"]);
  });
});

/**
 * Hosts a real scan met and could not name.
 *
 * Every URL here was contacted during a walk of a client's forms platform on
 * 2026-08-30. Five of the seven third parties came back "unknown", which
 * scores medium, so a product that records user sessions read exactly like an
 * unremarkable CDN.
 */
describe("what the first live scan could not name", () => {
  it("names Pendo", () => {
    for (const url of ["https://data.pendo.io/data/ptm.gif", "https://cdn.pendo.io/agent/x.js"]) {
      expect(identify(url).name).toBe("Pendo");
    }
  });

  /* CLASSIFIED ON WHAT WAS OBSERVED, NOT ON WHAT THE VENDOR SELLS.
     Pendo was first put in session-replay because Pendo sells session replay.
     That is a fact about a price list: replay is a feature an operator
     switches on, and a scan from outside cannot see whether it is enabled.
     Scoring a host into SEVERE_KINDS on something nobody measured is the
     crying wolf these detectors exist to avoid. */
  it("does not score a vendor by its price list", () => {
    expect(identify("https://data.pendo.io/data/ptm.gif").kind).toBe("analytics");
    expect(identify("https://dev.visualwebsiteoptimizer.com/j.php").kind).toBe("analytics");
  });

  it("names Visual Website Optimizer without overstating what it is", () => {
    expect(identify("https://dev.visualwebsiteoptimizer.com/j.php").name).toBe(
      "Visual Website Optimizer",
    );
  });

  it("names the product's own object storage so a reader can dismiss it", () => {
    expect(identify("https://cognitoprod.blob.core.windows.net/x.png").name).toBe(
      "Azure Blob Storage",
    );
  });

  /* reCAPTCHA is a security control the site uses to protect itself, which is
     close to the opposite of an unexplained tracker. The host alone cannot
     tell them apart, because google.com serves both. */
  it("tells reCAPTCHA apart from google.com generally", () => {
    expect(identify("https://www.google.com/recaptcha/api2/aframe")).toEqual({
      kind: "cdn",
      name: "Google reCAPTCHA",
    });
    expect(identify("https://www.google.com/search?q=x")).toEqual({ kind: "unknown", name: null });
  });

  it("still refuses to name a host it has no signature for", () => {
    expect(identify("https://telemetry.unknown.example/ingest")).toEqual({
      kind: "unknown",
      name: null,
    });
  });

  /* Dot-boundary, as elsewhere: a lookalike domain must not inherit a real
     vendor's name or its severity. */
  it("does not let a lookalike domain borrow a vendor name", () => {
    expect(identify("https://evil-pendo.io/x.js").name).toBeNull();
    expect(identify("https://notpendo.io/x.js").name).toBeNull();
  });
});

/**
 * The question a severity must not answer for you.
 *
 * A vendor that sells session recording is worth asking about. Whether that
 * feature is switched on is invisible from outside, so it belongs in a
 * question rather than in a score.
 */
describe("what a scan cannot prove but should ask", () => {
  it("asks about a vendor that could be recording", () => {
    const note = capabilityNote("data.pendo.io");
    expect(note).toMatch(/session replay/i);
    /* Phrased so it can be asked without accusing anybody. */
    expect(note).toMatch(/worth asking/i);
    expect(note).toMatch(/not visible from outside/i);
  });

  it("matches on the dot boundary like everything else here", () => {
    expect(capabilityNote("cdn.pendo.io")).not.toBeNull();
    expect(capabilityNote("evil-pendo.io")).toBeNull();
  });

  it("has nothing to ask about an ordinary host", () => {
    expect(capabilityNote("fonts.googleapis.com")).toBeNull();
  });
});
