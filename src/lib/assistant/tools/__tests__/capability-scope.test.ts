/**
 * Only claim what this deployment is connected to.
 *
 * Measured on 2026-08-31: no connectors configured, zero CRM events ever, zero
 * DMS events ever, and "what can you do" advertised six CRM capabilities and a
 * dealer inventory widget anyway.
 */
import {
  scopeToConnected,
  backingSystemFor,
  describeAwaiting,
  type BackingSystem,
} from "../capability-scope";

const t = (name: string) => ({ name });
const none = new Set<BackingSystem>();

describe("which system a tool needs", () => {
  it("recognises the CRM tools by name", () => {
    for (const n of [
      "search_external_records",
      "get_related_records",
      "filter_external_records",
      "aggregate_external_records",
    ]) {
      expect(backingSystemFor(n)).toBe("crm");
    }
  });

  it("recognises the dealer inventory tool", () => {
    expect(backingSystemFor("dms_inventory_widget")).toBe("dms");
  });

  /* Unmatched means needs nothing, which is the safe direction: a tool wrongly
     listed as always available is a tool that already worked. */
  it("assumes a tool needs nothing when it names no system", () => {
    expect(backingSystemFor("search_documents")).toBeNull();
    expect(backingSystemFor("what_can_you_do")).toBeNull();
  });
});

describe("scoping the menu to reality", () => {
  const tools = [t("search_documents"), t("search_external_records"), t("dms_inventory_widget")];

  /* THE MEASURED CASE. Nothing connected, so the two most tempting lines on
     the page for somebody running dealerships are the two that answer
     nothing. */
  it("keeps CRM and dealer tools out of the list when nothing is connected", () => {
    const scoped = scopeToConnected(tools, none);
    expect(scoped.available.map((x) => x.name)).toEqual(["search_documents"]);
    expect(scoped.awaiting.map((x) => x.name)).toEqual([
      "search_external_records",
      "dms_inventory_widget",
    ]);
  });

  it("lets them back in the moment the system is connected", () => {
    const scoped = scopeToConnected(tools, new Set<BackingSystem>(["crm"]));
    expect(scoped.available.map((x) => x.name)).toContain("search_external_records");
    expect(scoped.awaiting.map((x) => x.name)).toEqual(["dms_inventory_widget"]);
  });

  it("names each missing system once, however many tools need it", () => {
    const many = [t("search_external_records"), t("filter_external_records"), t("get_related_records")];
    expect(scopeToConnected(many, none).awaitingSystems).toEqual(["crm"]);
  });

  it("says nothing is waiting when everything is connected", () => {
    const scoped = scopeToConnected(tools, new Set<BackingSystem>(["crm", "dms"]));
    expect(scoped.awaiting).toEqual([]);
    expect(describeAwaiting(scoped.awaitingSystems)).toBeNull();
  });
});

describe("how the offer reads", () => {
  /* NOT CONNECTED IS NOT NOT BUILT. Six unavailable CRM capabilities listed
     one by one read as a product with holes in it. */
  it("offers a next step rather than listing what is missing", () => {
    const line = describeAwaiting(["crm", "dms"])!;
    expect(line).toMatch(/^Connect /);
    expect(line).toContain("a CRM");
    expect(line).toContain("dealer management system");
    expect(line).not.toMatch(/cannot|unavailable|not connected|missing/i);
  });

  it("reads as a sentence for one system", () => {
    expect(describeAwaiting(["crm"])).toBe("Connect a CRM and I can answer about that too.");
  });
});
