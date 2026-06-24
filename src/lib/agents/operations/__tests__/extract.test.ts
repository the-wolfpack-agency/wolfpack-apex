/**
 * Pure field-extraction helpers for the declarative operation registry. These
 * back every operation's field extractors, so they are tested directly: the QR
 * example the feature must support plus the edge cases that keep a NEW operation
 * declarative.
 */

import {
  extractUrl,
  extractLabel,
  extractSearchQuery,
} from "@/lib/agents/operations/extract";

describe("extractUrl", () => {
  it("normalizes a bare domain after 'linked to' to an https URL", () => {
    expect(extractUrl("Create a QR code linked to ogiam.com")).toBe(
      "https://ogiam.com",
    );
  });

  it("handles the full QR example (label clause before the link)", () => {
    expect(
      extractUrl("Create a QR code titled AGENT1 that is linked to ogiam.com"),
    ).toBe("https://ogiam.com");
  });

  it("returns an explicit http(s) URL verbatim", () => {
    expect(extractUrl("make a qr for https://example.com/path?x=1")).toBe(
      "https://example.com/path?x=1",
    );
  });

  it("prefers an explicit URL over a bare-domain phrase", () => {
    expect(extractUrl("qr to https://a.com not b.com")).toBe("https://a.com");
  });

  it("normalizes a bare domain after 'to' / 'for'", () => {
    expect(extractUrl("generate a qr to acme.io")).toBe("https://acme.io");
    expect(extractUrl("new qr for shop.example.co.uk")).toBe(
      "https://shop.example.co.uk",
    );
  });

  it("keeps a path on a bare domain", () => {
    expect(extractUrl("qr linked to ogiam.com/promo")).toBe(
      "https://ogiam.com/promo",
    );
  });

  it("strips trailing sentence punctuation", () => {
    expect(extractUrl("qr linked to ogiam.com.")).toBe("https://ogiam.com");
    expect(extractUrl("qr to https://x.com, please")).toBe("https://x.com");
  });

  it("returns undefined when there is no URL or domain", () => {
    expect(extractUrl("create a qr code")).toBeUndefined();
    expect(extractUrl("")).toBeUndefined();
    expect(extractUrl("link it to the homepage")).toBeUndefined();
  });
});

describe("extractLabel", () => {
  it("pulls a 'titled X' label and stops before the link clause", () => {
    expect(
      extractLabel("Create a QR code titled AGENT1 that is linked to ogiam.com"),
    ).toBe("AGENT1");
  });

  it("handles called / named", () => {
    expect(extractLabel("make a qr called Spring Sale")).toBe("Spring Sale");
    expect(extractLabel("qr named Promo to ogiam.com")).toBe("Promo");
  });

  it("supports quoted labels", () => {
    expect(extractLabel('qr titled "Q2 Launch" linked to a.com')).toBe(
      "Q2 Launch",
    );
  });

  it("returns undefined when there is no label clause", () => {
    expect(extractLabel("create a qr linked to ogiam.com")).toBeUndefined();
    expect(extractLabel("")).toBeUndefined();
  });
});

describe("extractSearchQuery", () => {
  it("pulls the query from the canonical scan-the-internet example", () => {
    expect(
      extractSearchQuery(
        "scan the internet for the latest news on auto SAAS companies",
      ),
    ).toBe("the latest news on auto SAAS companies");
  });

  it("trims trailing punctuation from the query", () => {
    expect(
      extractSearchQuery(
        "scan the internet for the latest news on auto SAAS companies.",
      ),
    ).toBe("the latest news on auto SAAS companies");
  });

  it("handles 'search the web for X'", () => {
    expect(extractSearchQuery("search the web for Tesla earnings")).toBe(
      "Tesla earnings",
    );
  });

  it("handles 'search for X'", () => {
    expect(extractSearchQuery("search for best CRM software 2026")).toBe(
      "best CRM software 2026",
    );
  });

  it("handles 'look up X online' and strips the trailing qualifier", () => {
    expect(extractSearchQuery("look up the GDP of France online")).toBe(
      "the GDP of France",
    );
  });

  it("handles 'find news on X'", () => {
    expect(extractSearchQuery("find news on OpenAI funding")).toBe(
      "OpenAI funding",
    );
  });

  it("handles 'the latest news on X'", () => {
    expect(extractSearchQuery("the latest news on EV tax credits")).toBe(
      "EV tax credits",
    );
  });

  it("preserves a query that has no leading connective", () => {
    expect(extractSearchQuery("research quantum computing startups")).toBe(
      "quantum computing startups",
    );
  });

  it("returns undefined for empty input", () => {
    expect(extractSearchQuery("")).toBeUndefined();
    expect(extractSearchQuery("   ")).toBeUndefined();
  });
});
