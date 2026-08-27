/**
 * A chip that cannot work is worse than no chip.
 *
 * When the assistant cannot answer, it offers buttons. One of them has always
 * been "A financial figure", and QuickBooks has never held a token on this
 * deployment: zero rows, for the whole life of the feature. Every person who
 * ever saw the fallback was offered a button that could not work, and spent a
 * click learning the product is broken.
 *
 * The call site's own comment named this and only the role half was fixed.
 * These pin the other half, in both directions: the dead chip goes, and a
 * lookup that FAILS must not silently shrink the menu to nothing.
 */

import { buildChoices, CHOICES } from "@/lib/assistant/choices";
import "@/lib/assistant/tools";

const ROLE = "cto";

describe("chips that depend on an integration", () => {
  it("drops the financial chip when QuickBooks is known disconnected", () => {
    const withQb = buildChoices("what is our revenue", ROLE, {}).map((c) => c.label);
    const withoutQb = buildChoices("what is our revenue", ROLE, {
      knownDisconnected: new Set(["quickbooks"]),
    }).map((c) => c.label);

    expect(withQb).toContain("A financial figure");
    expect(withoutQb).not.toContain("A financial figure");
  });

  it("drops calendar and email chips when Microsoft is not connected", () => {
    const labels = buildChoices("what is on my calendar", ROLE, {
      knownDisconnected: new Set(["microsoft"]),
    }).map((c) => c.label);
    expect(labels).not.toContain("My calendar");
    expect(labels).not.toContain("Search email");
  });

  it("still offers what works from the product's own data", () => {
    /* THE HALF THAT MATTERS MOST. Removing dead chips must not leave somebody
       staring at an empty panel; the point is to move them forward. */
    const labels = buildChoices("what is our revenue", ROLE, {
      knownDisconnected: new Set(["quickbooks", "microsoft", "github"]),
    }).map((c) => c.label);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels).toEqual(expect.arrayContaining(["Search everything"]));
  });
});

describe("when the connection lookup tells us nothing", () => {
  it("changes nothing, because an unknown is not a disconnection", () => {
    /* A transient database failure must not shrink the product. Passing no
       set, or an empty one, offers the full menu. */
    const full = buildChoices("what is our revenue", ROLE, {}).map((c) => c.label);
    const empty = buildChoices("what is our revenue", ROLE, {
      knownDisconnected: new Set(),
    }).map((c) => c.label);
    expect(empty).toEqual(full);
  });

  it("keeps the old numeric limit argument working", () => {
    /* Existing callers pass a number. Breaking them to add an option bag
       would be a regression bought for tidiness. */
    expect(buildChoices("anything", ROLE, 2)).toHaveLength(2);
  });
});

describe("the declaration itself", () => {
  it("every integration-dependent chip says which integration", () => {
    /* The list is the contract. A chip added without declaring its dependency
       is the next dead button. */
    const needsOne = ["calendar_widget", "search_mail", "get_financials_metric", "recent_workflow_runs"];
    for (const tool of needsOne) {
      const chip = CHOICES.find((c) => c.tool === tool);
      expect(chip?.requires).toBeTruthy();
    }
  });

  it("chips that read the product's own data declare nothing", () => {
    /* Over-declaring is its own bug: it would hide a working button whenever
       an unrelated integration went down. */
    for (const tool of ["upload_to_brain", "search", "feedback"]) {
      expect(CHOICES.find((c) => c.tool === tool)?.requires).toBeUndefined();
    }
  });
});
