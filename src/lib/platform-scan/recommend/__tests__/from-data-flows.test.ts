/**
 * Turning a data-flow map into a plan of attack.
 *
 * recommendAutomations reads a SystemProfile, built from a repository. A
 * client who granted access to their running systems has given us none of
 * that, so profile is null and the integration plays never fire. The
 * engagement that needs recommendations most gets the fewest.
 *
 * The data-flow map carries the same signal from outside, and observed is the
 * stronger evidence: a dependency in a manifest may be dead code, while a
 * script tag on a live page is something their users load today.
 */
import {
  recommendFromDataFlows,
  vendorForOrigin,
} from "@/lib/platform-scan/recommend/from-data-flows";
import type { DataFlowMap } from "@/lib/platform-scan/mapping/data-flow";

const empty: DataFlowMap = { entryPoints: [], exitPoints: [], pagesRead: 0 };

const form = (over: Partial<DataFlowMap["entryPoints"][number]> = {}) => ({
  page: "https://client.example.com/checkout",
  action: "https://pay.vendor.io/collect",
  method: "POST",
  crossOrigin: true,
  sensitiveFields: ["card_number"],
  ...over,
});

const exit = (origin: string, pages = 1) => ({
  origin,
  via: ["script"],
  pages: Array.from({ length: pages }, (_, i) => `/p${i}`),
});

describe("recognising a vendor", () => {
  it.each([
    ["https://js.stripe.com", "Stripe"],
    ["https://api.stripe.com", "Stripe"],
    ["https://js.hs-scripts.com", "HubSpot"],
    ["https://cdn.plaid.com", "Plaid"],
  ])("maps %s to %s", (origin, vendor) => {
    expect(vendorForOrigin(origin)).toBe(vendor);
  });

  /* Anchored at a dot, so a lookalike domain cannot borrow a vendor's name in
     a client report. */
  it.each(["https://notstripe.com", "https://stripe.com.evil.net"])(
    "does not match the lookalike %s",
    (origin) => {
      expect(vendorForOrigin(origin)).toBeNull();
    },
  );

  it("returns null for anything it does not recognise, rather than guessing", () => {
    expect(vendorForOrigin("https://analytics.unknown-co.example")).toBeNull();
  });
});

describe("data leaving to a third party", () => {
  /* The one an engineer acts on first: typed input reaching a company before
     it reaches the client. */
  it("raises a critical when a cross-origin form carries sensitive fields", () => {
    const recs = recommendFromDataFlows({ ...empty, entryPoints: [form()] });
    const crit = recs.find((r) => r.priority === "critical");

    expect(crit).toBeDefined();
    expect(crit!.category).toBe("security_remediation");
    expect(crit!.evidence.fields).toBe("card_number");
  });

  /* A form posting to its own origin is normal. Raising it would train
     everyone to ignore the critical ones. */
  it("says nothing about a form posting to its own site", () => {
    const recs = recommendFromDataFlows({
      ...empty,
      entryPoints: [form({ crossOrigin: false })],
    });
    expect(recs).toEqual([]);
  });

  /* An architectural fact, not an incident, so it is noted once rather than
     per form. */
  it("groups plain cross-origin forms into a single note", () => {
    const recs = recommendFromDataFlows({
      ...empty,
      entryPoints: [
        form({ sensitiveFields: [], action: "/a" }),
        form({ sensitiveFields: [], action: "/b" }),
        form({ sensitiveFields: [], action: "/c" }),
      ],
    });
    const grouped = recs.filter((r) => r.key === "quality:cross_origin_forms");
    expect(grouped).toHaveLength(1);
    expect(grouped[0].evidence.count).toBe(3);
  });
});

describe("the vendors they already use", () => {
  it("proposes the automation for a vendor observed on live pages", () => {
    const recs = recommendFromDataFlows({
      ...empty,
      exitPoints: [exit("https://js.stripe.com", 4)],
    });
    const rec = recs.find((r) => r.source === "data_flow:vendor:Stripe");

    expect(rec).toBeDefined();
    expect(rec!.category).toBe("integration_automation");
    expect(rec!.rationale).toMatch(/already exists/i);
    expect(rec!.evidence.pages).toBe(4);
  });

  it("proposes each vendor once, however many origins it serves from", () => {
    const recs = recommendFromDataFlows({
      ...empty,
      exitPoints: [exit("https://js.stripe.com"), exit("https://api.stripe.com")],
    });
    expect(recs.filter((r) => r.source === "data_flow:vendor:Stripe")).toHaveLength(1);
  });

  /* Naming the wrong company in a client report costs more trust than a miss
     costs coverage. */
  it("never invents a play for an unrecognised origin", () => {
    const recs = recommendFromDataFlows({
      ...empty,
      exitPoints: [exit("https://something.unknown.example")],
    });
    expect(recs.filter((r) => r.category === "integration_automation")).toEqual([]);
  });
});

describe("sprawl", () => {
  it("raises unrecognised third parties only once there are enough to matter", () => {
    const four = Array.from({ length: 4 }, (_, i) => exit(`https://v${i}.example`));
    expect(
      recommendFromDataFlows({ ...empty, exitPoints: four }).filter(
        (r) => r.key === "operational:third_party_sprawl",
      ),
    ).toEqual([]);

    const five = Array.from({ length: 5 }, (_, i) => exit(`https://v${i}.example`));
    const recs = recommendFromDataFlows({ ...empty, exitPoints: five });
    expect(recs.find((r) => r.key === "operational:third_party_sprawl")?.evidence.count).toBe(5);
  });

  it("does not count recognised vendors as unidentified", () => {
    const mixed = [
      exit("https://js.stripe.com"),
      ...Array.from({ length: 4 }, (_, i) => exit(`https://v${i}.example`)),
    ];
    const recs = recommendFromDataFlows({ ...empty, exitPoints: mixed });
    expect(recs.find((r) => r.key === "operational:third_party_sprawl")).toBeUndefined();
  });
});

describe("an empty map", () => {
  it("recommends nothing rather than inventing work", () => {
    expect(recommendFromDataFlows(empty)).toEqual([]);
  });
});
