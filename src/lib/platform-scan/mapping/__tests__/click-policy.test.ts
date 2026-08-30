/**
 * Navigate freely. Mutate never.
 *
 * WHY THE OLD RULE WAS TOO BLUNT. explore.ts refuses to click anything, for a
 * good reason it states plainly: on a live Salesforce a stray click can
 * convert a lead, send an email or fire a workflow.
 *
 * But a modern dashboard keeps its structure behind tabs and client-side
 * routing rather than behind <a href>, so a link-only crawler maps the shell
 * of an app and reports it as the app. "Never click" buys safety by buying
 * blindness.
 *
 * THE ASYMMETRY IS THE WHOLE DESIGN. Refusing a harmless tab costs one
 * unexplored control. Clicking one unrecognised "Publish" puts a client's live
 * form out into the world. Those are not the same size, so the default is not
 * symmetrical: anything unrecognised is refused.
 */

import { mayClick, partitionByPolicy, type ClickCandidate } from "@/lib/platform-scan/mapping/click-policy";

const el = (over: Partial<ClickCandidate>): ClickCandidate => ({
  tag: "button",
  text: "",
  ...over,
});

describe("things that change something are refused", () => {
  it.each([
    "Create form",
    "New user",
    "Add member",
    "Delete",
    "Remove from team",
    "Save",
    "Submit request",
    "Send invitation",
    "Invite user",
    "Publish form",
    "Archive",
    "Duplicate",
    "Approve",
    "Reject",
    "Reset password",
    "Deactivate account",
    "Export all data",
    "Run workflow",
  ])("refuses %s", (text) => {
    const v = mayClick(el({ text }));
    expect(v.allowed).toBe(false);
  });

  /* THE ONE THAT WOULD HURT MOST during an authenticated map: it does not
     damage the client, it silently turns the rest of the run into an
     unauthenticated crawl and every page after it is wrong. */
  it.each(["Log out", "Sign out", "Switch account", "End session"])(
    "refuses %s because it would invalidate the rest of the map",
    (text) => {
      const v = mayClick(el({ text }));
      expect(v.allowed).toBe(false);
      expect(v.because).toMatch(/end the session/i);
    },
  );

  /* A friendly label does not undo what the browser declares. "Continue" on a
     submit button still posts. */
  it("refuses a submit however friendly its label", () => {
    expect(mayClick(el({ text: "Continue", type: "submit" })).allowed).toBe(false);
  });

  /* Order matters: a refusal must beat a navigational word inside the same
     label, or "Save filter" reads as a filter. */
  it("refuses a control whose label mixes both", () => {
    expect(mayClick(el({ text: "Save filter" })).allowed).toBe(false);
    expect(mayClick(el({ text: "Export view" })).allowed).toBe(false);
  });
});

describe("things that only move you around are allowed", () => {
  it.each([
    "Next",
    "Previous",
    "Show more",
    "Load more",
    "View all",
    "Expand",
    "Details",
    "Settings",
    "Overview",
    "Filter",
    "Refresh",
  ])("allows %s", (text) => {
    expect(mayClick(el({ text })).allowed).toBe(true);
  });

  it("allows an ordinary link", () => {
    expect(mayClick(el({ tag: "a", text: "Forms", href: "/forms" })).allowed).toBe(true);
  });

  it.each(["tab", "menuitem", "treeitem"])("allows role=%s", (role) => {
    expect(mayClick(el({ text: "Responses", role })).allowed).toBe(true);
  });

  it("allows a disclosure control", () => {
    expect(mayClick(el({ text: "Advanced", ariaExpanded: false })).allowed).toBe(true);
  });

  it("allows a details summary", () => {
    expect(mayClick(el({ tag: "summary", text: "More" })).allowed).toBe(true);
  });

  /* An icon-only control identified by aria-label is still identifiable. */
  it("reads an aria-label when there is no visible text", () => {
    expect(mayClick(el({ text: "", label: "Next page" })).allowed).toBe(true);
    expect(mayClick(el({ text: "", label: "Delete row" })).allowed).toBe(false);
  });
});

describe("the default, which is the point of the file", () => {
  /* An unrecognised control is refused. A smaller map is a cost we absorb. */
  it("refuses anything it does not recognise", () => {
    const v = mayClick(el({ text: "Flurb" }));
    expect(v.allowed).toBe(false);
    expect(v.because).toMatch(/unrecognised/i);
  });

  /* AN UNLABELLED ICON COULD BE REFRESH OR DELETE and there is no way to tell.
     That it cannot be identified is a finding, not a reason to try it. */
  it("refuses an unlabelled control rather than guessing", () => {
    const v = mayClick(el({ text: "", label: "" }));
    expect(v.allowed).toBe(false);
    expect(v.because).toMatch(/accessible name/i);
  });

  it("refuses a disabled control", () => {
    expect(mayClick(el({ text: "Next", disabled: true })).allowed).toBe(false);
  });

  /* Inside a form, everything exists to act on the form except plain
     navigation. */
  it("refuses an ambiguous control inside a form", () => {
    expect(mayClick(el({ text: "Continue", insideForm: true })).allowed).toBe(false);
  });

  it("still allows paging inside a form", () => {
    expect(mayClick(el({ text: "Next", insideForm: true })).allowed).toBe(true);
  });
});

describe("reporting what was declined", () => {
  /* A map that silently skips half a page overstates its coverage. What was
     refused, and why, is part of the finding. */
  it("returns the reason for every refusal", () => {
    const { clickable, declined } = partitionByPolicy([
      el({ text: "Next" }),
      el({ text: "Delete" }),
      el({ text: "", label: "" }),
    ]);
    expect(clickable).toHaveLength(1);
    expect(declined).toHaveLength(2);
    expect(declined.every((d) => d.because.length > 10)).toBe(true);
  });
});

/**
 * A MODAL THAT CANNOT BE DISMISSED BLOCKS EVERYTHING BEHIND IT.
 *
 * Measured while mapping this product: "Close welcome" was refused, because
 * "close" is also how a ticket is closed and refusals run before permissions.
 * One unclosable dialog costs the whole map below it.
 *
 * Loosening "close" globally would be the wrong fix, since closing a record is
 * genuinely mutating. The dialog role is the discriminator, because it says
 * what the control is closing rather than what it is called.
 */
describe("dismissing a dialog", () => {
  const inDialog = (text: string) => mayClick(el({ text, insideDialog: true }));

  it.each(["Close", "Close welcome", "Dismiss", "Got it", "Not now", "No thanks", "Skip", "×"])(
    "allows %s inside a dialog",
    (text) => {
      expect(inDialog(text).allowed).toBe(true);
    },
  );

  /* THE LINE THAT MATTERS. A confirmation modal is still full of real
     buttons, and this must never become a way to press one. */
  it.each(["Close ticket", "Delete", "Close and delete", "Save", "Approve", "Send"])(
    "still refuses %s inside a dialog",
    (text) => {
      expect(inDialog(text).allowed).toBe(false);
    },
  );

  /* Outside a dialog the old behaviour is unchanged: "Close" there is
     overwhelmingly closing a record. */
  it("does not allow a bare Close outside a dialog", () => {
    expect(mayClick(el({ text: "Close welcome" })).allowed).toBe(false);
  });

  it("still refuses a logout inside a dialog", () => {
    expect(inDialog("Sign out").allowed).toBe(false);
  });
});
