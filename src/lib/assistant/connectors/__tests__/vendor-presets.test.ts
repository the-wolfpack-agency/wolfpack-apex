/**
 * Vendor preset tests — pin the search-builder contracts so a future
 * Salesforce / HubSpot quirk doesn't silently break the search tool.
 */

import { getVendorPreset } from "@/lib/assistant/connectors/vendor-presets";

describe("Salesforce preset — search.build", () => {
  const sf = getVendorPreset("salesforce");
  if (!sf?.search) throw new Error("Salesforce preset must have a search builder");
  const { search } = sf;

  test("contact search builds SOQL targeting Name + Email LIKE %query%", () => {
    const r = search.build("contact", "Grimace", 5);
    expect(r.path).toContain("/services/data/v59.0/query");
    /* SOQL is URL-encoded into the q parameter. Decode to inspect. */
    const url = new URL("http://x" + r.path);
    const soql = url.searchParams.get("q") ?? "";
    expect(soql).toContain("FROM Contact");
    expect(soql).toContain("Name LIKE '%Grimace%'");
    expect(soql).toContain("Email LIKE '%Grimace%'");
    expect(soql).toContain("LIMIT 5");
    expect(soql).toContain("AccountId,Account.Name");
  });

  test("deal alias → Opportunity SOQL", () => {
    const r = search.build("deal", "Acme", 10);
    const soql = new URL("http://x" + r.path).searchParams.get("q") ?? "";
    expect(soql).toContain("FROM Opportunity");
    expect(soql).toContain("StageName,Amount,CloseDate");
  });

  test("account alias → Account SOQL with Industry + Phone", () => {
    const r = search.build("account", "McDonalds", 3);
    const soql = new URL("http://x" + r.path).searchParams.get("q") ?? "";
    expect(soql).toContain("FROM Account");
    expect(soql).toContain("Industry");
    expect(soql).toContain("Phone");
  });

  test("single-quote in query gets SOQL-escaped (no injection)", () => {
    /* SOQL string literals wrap in single quotes, so embedded quotes
       must be backslash-escaped. A query like O'Brien must NOT close
       the literal mid-string. */
    const r = search.build("contact", "O'Brien", 5);
    const soql = new URL("http://x" + r.path).searchParams.get("q") ?? "";
    /* The escape: O'Brien → O\'Brien inside the SOQL literal. */
    expect(soql).toContain("Name LIKE '%O\\'Brien%'");
    /* The literal must STILL be properly closed — no unmatched quote. */
    const singleQuotes = (soql.match(/(?<!\\)'/g) || []).length;
    expect(singleQuotes % 2).toBe(0);
  });

  test("backslash gets escaped, not dropped (complete SOQL escaping)", () => {
    /* A literal backslash must be doubled inside a SOQL string literal.
       Stripping it (the old behavior) silently lost input and tripped
       CodeQL's incomplete-sanitization rule; escaping is the correct,
       lossless form. back\slash → back\\slash. */
    const r = search.build("contact", "back\\slash", 5);
    const soql = new URL("http://x" + r.path).searchParams.get("q") ?? "";
    expect(soql).toContain("back\\\\slash");
    /* And the escaping backslash must not leave a dangling odd count
       that could break out of the literal. */
    expect((soql.match(/\\/g) || []).length % 2).toBe(0);
  });

  test("extract pulls records from {records:[...]} SF response shape", () => {
    const r = search.build("contact", "x", 1);
    const extracted = r.extract({
      totalSize: 1,
      done: true,
      records: [{ Id: "003abc", Name: "Grimace" }],
    });
    expect(extracted).toHaveLength(1);
    expect(extracted[0].Id).toBe("003abc");
  });

  test("extract returns [] when records key missing or wrong shape", () => {
    const { extract } = search.build("contact", "x", 1);
    expect(extract({})).toEqual([]);
    expect(extract({ records: "not-an-array" })).toEqual([]);
    expect(extract(null)).toEqual([]);
  });

  test("unknown object type falls back to Contact (no crash)", () => {
    const r = search.build("ticket", "Acme", 5);
    const soql = new URL("http://x" + r.path).searchParams.get("q") ?? "";
    expect(soql).toContain("FROM Contact");
  });

  test("empty query = LIST-ALL → no-WHERE SOQL with a LIMIT", () => {
    /* The "client list" / "pull the customer list" path: an empty query
       must build a list-all (no WHERE filter) capped by the limit. */
    const r = search.build("contact", "", 25);
    const soql = new URL("http://x" + r.path).searchParams.get("q") ?? "";
    expect(soql).toContain("FROM Contact");
    expect(soql).toContain("LIMIT 25");
    expect(soql).not.toContain("WHERE");
    expect(soql).not.toContain("LIKE");
  });

  test("whitespace-only query is also treated as LIST-ALL", () => {
    const r = search.build("account", "   ", 10);
    const soql = new URL("http://x" + r.path).searchParams.get("q") ?? "";
    expect(soql).toContain("FROM Account");
    expect(soql).not.toContain("WHERE");
  });
});

describe("HubSpot preset — search.build", () => {
  const hs = getVendorPreset("hubspot");
  if (!hs?.search) throw new Error("HubSpot preset must have a search builder");
  const { search } = hs;

  test("contact search builds GET /crm/v3/objects/contacts?q=...&limit=...", () => {
    const r = search.build("contact", "grimace", 5);
    expect(r.path).toContain("/crm/v3/objects/contacts?q=grimace&limit=5");
  });

  test("URL-encodes special characters", () => {
    const r = search.build("contact", "O'Brien & Co", 5);
    expect(r.path).toContain("q=O'Brien%20%26%20Co");
  });

  test("extract pulls records from {results:[...]} shape", () => {
    const r = search.build("contact", "x", 1);
    const extracted = r.extract({
      total: 1,
      results: [{ id: "123", properties: { firstname: "Grimace" } }],
    });
    expect(extracted).toHaveLength(1);
    expect(extracted[0].id).toBe("123");
  });

  test("empty query = LIST-ALL → bare list endpoint, no q param", () => {
    const r = search.build("contact", "", 25);
    expect(r.path).toBe("/crm/v3/objects/contacts?limit=25");
    expect(r.path).not.toContain("q=");
  });
});

describe("getVendorPreset", () => {
  test("returns null for unknown vendor (e.g. rest-default)", () => {
    expect(getVendorPreset("rest-default")).toBeNull();
    expect(getVendorPreset("bogus")).toBeNull();
  });

  test("QuickBooks preset has no search builder (deferred)", () => {
    const qbo = getVendorPreset("quickbooks");
    expect(qbo?.search).toBeUndefined();
  });
});
