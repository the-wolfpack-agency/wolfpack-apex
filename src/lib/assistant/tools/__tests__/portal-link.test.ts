/**
 * portal-link helper — unit test for the maybePortalSource builder.
 *
 * The helper is the single point of truth for "should this answer
 * carry a Wolfpack-portal source chip?" — so it MUST refuse on
 * non-Salesforce connectors and MUST map all known object aliases
 * (deal → opportunities, company → accounts) correctly.
 */

import { maybePortalSource } from "@/lib/assistant/tools/portal-link";

describe("maybePortalSource", () => {
  test("returns null for non-Salesforce connectors", () => {
    expect(
      maybePortalSource({ connectorName: "hubspot", objectType: "contact", id: "001abc" }),
    ).toBeNull();
    expect(
      maybePortalSource({ connectorName: "rest-default", objectType: "contact", id: "001abc" }),
    ).toBeNull();
  });

  test("returns null when id is empty", () => {
    expect(
      maybePortalSource({ connectorName: "salesforce", objectType: "contact", id: "" }),
    ).toBeNull();
  });

  test("returns null on unknown object type", () => {
    expect(
      maybePortalSource({ connectorName: "salesforce", objectType: "invoice", id: "x" }),
    ).toBeNull();
  });

  test("maps contact → contacts portal", () => {
    const s = maybePortalSource({ connectorName: "salesforce", objectType: "contact", id: "003abc" });
    expect(s).not.toBeNull();
    expect(s?.url).toBe("/portal/salesforce/contacts/003abc");
    expect(s?.type).toBe("portal");
  });

  test("maps deal AND opportunity → opportunities portal", () => {
    const s1 = maybePortalSource({ connectorName: "salesforce", objectType: "deal", id: "006xyz" });
    const s2 = maybePortalSource({ connectorName: "salesforce", objectType: "opportunity", id: "006xyz" });
    expect(s1?.url).toBe("/portal/salesforce/opportunities/006xyz");
    expect(s2?.url).toBe("/portal/salesforce/opportunities/006xyz");
  });

  test("maps account AND company → accounts portal", () => {
    const s1 = maybePortalSource({ connectorName: "salesforce", objectType: "account", id: "001q" });
    const s2 = maybePortalSource({ connectorName: "salesforce", objectType: "company", id: "001q" });
    expect(s1?.url).toBe("/portal/salesforce/accounts/001q");
    expect(s2?.url).toBe("/portal/salesforce/accounts/001q");
  });

  test("encodes the id segment so unusual chars round-trip", () => {
    const s = maybePortalSource({ connectorName: "salesforce", objectType: "contact", id: "id with space" });
    expect(s?.url).toBe("/portal/salesforce/contacts/id%20with%20space");
  });
});
