/**
 * What each dealer system can actually tell us.
 *
 * Our client's dealers run at least three different systems. Whether that is a
 * week of work or a quarter depends on how much of each has to be rebuilt
 * rather than mapped, and until this existed nobody could say.
 */
import {
  CANONICAL_FIELDS,
  VENDOR_COVERAGE,
  coverageFor,
  unsupportedFields,
  whyEmpty,
  readCoverage,
  describeGap,
} from "../vendor-coverage";

describe("what a vendor can supply", () => {
  it("knows the one vendor that is implemented", () => {
    const cov = coverageFor("wolfpack-auto")!;
    expect(cov.provides).toEqual(CANONICAL_FIELDS);
    expect(cov.access).toBe("public-listing");
  });

  /* An empty row is the honest statement of outstanding work. Leaving the
     unmapped vendors out would make the report look finished. */
  it("lists the systems that are not mapped rather than omitting them", () => {
    const unmapped = VENDOR_COVERAGE.filter((v) => v.access === "not-mapped");
    expect(unmapped.map((v) => v.vendor)).toEqual(["cdk", "reynolds", "tekion"]);
    for (const v of unmapped) expect(v.provides).toEqual([]);
  });

  /* An unknown vendor supplies nothing until somebody says otherwise, which
     is the safe direction: the alternative is claiming a field we have never
     seen. */
  it("assumes an unknown vendor supplies nothing", () => {
    expect(unsupportedFields("some-system-nobody-mapped")).toEqual(CANONICAL_FIELDS);
  });
});

describe("the three meanings of a blank field", () => {
  /* To a dealer, "we cannot see the price" and "this one has no price" are
     completely different, and a blank cell renders them identically. */
  it("tells a vendor that cannot supply a field from a vehicle with no value", () => {
    expect(whyEmpty("cdk", "price")).toBe("vendor-cannot-supply");
    expect(whyEmpty("wolfpack-auto", "price")).toBe("no-value-for-this-vehicle");
  });

  it("names the system rather than apologizing", () => {
    const line = describeGap("cdk", ["price", "vin"])!;
    expect(line).toContain("CDK");
    expect(line).toMatch(/does not expose/);
    /* Actionable: a dealer knows which system they run. */
    expect(line).not.toMatch(/unavailable|error|sorry/i);
  });

  it("says nothing when the vendor covers what was asked", () => {
    expect(describeGap("wolfpack-auto", ["price", "vin"])).toBeNull();
  });
});

describe("how much adjustment each system needs", () => {
  /* The number that answers the scoping question. */
  it("reports coverage as a fraction per vendor", () => {
    const rows = readCoverage();
    const auto = rows.find((r) => r.vendor === "wolfpack-auto")!;
    expect(auto.provided).toBe(auto.total);
    expect(auto.missing).toEqual([]);

    const cdk = rows.find((r) => r.vendor === "cdk")!;
    expect(cdk.provided).toBe(0);
    expect(cdk.missing).toEqual(CANONICAL_FIELDS);
  });

  /* THE HONEST CAVEAT ABOUT THE CANONICAL SHAPE ITSELF. Full coverage of
     eight listing fields is not the same as covering what a dealer needs: the
     shape describes a website listing, because the only implemented vendor is
     one. Nothing here should be read as "wolfpack-auto covers a DMS". */
  it("records that the implemented vendor is a listing, not a dealer system", () => {
    const cov = coverageFor("wolfpack-auto")!;
    expect(cov.access).toBe("public-listing");
    expect(cov.note).toMatch(/nothing about cost, age on the lot or stock status/i);
  });

  it("distinguishes how a vendor is reached, because it drives the cost", () => {
    expect(coverageFor("cdk")!.access).toBe("not-mapped");
    expect(coverageFor("cdk")!.note).toMatch(/credentialed API/i);
  });
});
