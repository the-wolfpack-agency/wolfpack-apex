/**
 * Only suggest what will actually answer.
 *
 * The file being tested already had the right instinct in a comment: "chips
 * that 400 on click are a worse first impression than chips that don't exist".
 * It was applied by hardcoding a role, which cannot know whether a source is
 * reachable today.
 *
 * Measured on production over sixty days: "financials are not connected yet,
 * so there is no figure to read" was answered six times. Every one was
 * somebody following a suggestion into a wall, on what is often their first
 * try, which is the most expensive moment to teach a user the product does not
 * work.
 */
import {
  welcomePromptsFor,
  welcomePromptTextsFor,
  welcomePromptsForRole,
} from "@/lib/assistant/welcome-prompts";

describe("filtering by what is connected", () => {
  it("removes a prompt whose source is known to be unavailable", () => {
    const withCalendar = welcomePromptsFor("cto", { calendar: true });
    const without = welcomePromptsFor("cto", { calendar: false });

    expect(withCalendar.some((p) => p.requires === "calendar")).toBe(true);
    expect(without.some((p) => p.requires === "calendar")).toBe(false);
  });

  it("keeps prompts that depend on nothing", () => {
    const out = welcomePromptsFor("cto", {
      calendar: false,
      mail: false,
      documents: false,
      tasks: false,
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((p) => !p.requires)).toBe(true);
  });

  /* UNKNOWN IS NOT UNAVAILABLE. Hiding a capability because a status check
     timed out would quietly shrink the product every time something was
     briefly slow, and a user who never sees a feature cannot ask for it. */
  it("keeps a prompt when the source was not checked at all", () => {
    const unchecked = welcomePromptsFor("cto", {});
    expect(unchecked).toEqual(welcomePromptsForRole("cto"));
  });

  it("keeps a prompt when only some sources were checked", () => {
    const out = welcomePromptsFor("cto", { mail: false });
    expect(out.some((p) => p.requires === "calendar")).toBe(true);
    expect(out.some((p) => p.requires === "mail")).toBe(false);
  });

  /* An empty starter screen is a worse first impression than one offering
     something general, and somebody with nothing connected still needs a way
     in. */
  it("never returns nothing", () => {
    const out = welcomePromptsFor("dev", {
      calendar: false,
      mail: false,
      documents: false,
      tasks: false,
    });
    expect(out.length).toBeGreaterThan(0);
  });

  it("falls back to the generic kit for an unknown role, still filtered", () => {
    const out = welcomePromptsFor("intern", { calendar: false });
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((p) => p.requires === "calendar")).toBe(false);
  });
});

describe("the plain-text form used by the fallback path", () => {
  /* Suggesting a dead end at the moment an answer already came back thin is
     the worst possible time to do it. */
  it("filters the same way", () => {
    const texts = welcomePromptTextsFor("cto", { calendar: false, mail: false });
    expect(texts.every((t) => typeof t === "string")).toBe(true);
    expect(texts.some((t) => /calendar/i.test(t))).toBe(false);
    expect(texts.some((t) => /email/i.test(t))).toBe(false);
  });

  it("still offers something when nothing is connected", () => {
    expect(
      welcomePromptTextsFor("cto", {
        calendar: false,
        mail: false,
        documents: false,
        tasks: false,
      }).length,
    ).toBeGreaterThan(0);
  });
});

describe("the kits themselves", () => {
  /* A requirement nobody can satisfy would silently remove a prompt forever.
     This catches a typo in a tag. */
  it("only uses requirements the filter understands", () => {
    const known = new Set(["calendar", "mail", "documents", "tasks", undefined]);
    for (const role of ["cto", "dev", "sales", "ops", "hr", "unknown-role"]) {
      for (const p of welcomePromptsForRole(role)) {
        expect(known.has(p.requires)).toBe(true);
      }
    }
  });

  /* Every kit needs at least one prompt that works with nothing connected, or
     a brand-new workspace shows an empty screen. */
  it.each(["cto", "dev", "sales", "ops", "hr", "unknown-role"])(
    "leaves %s something that works with nothing connected",
    (role) => {
      expect(welcomePromptsForRole(role).some((p) => !p.requires)).toBe(true);
    },
  );
});
