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
  PROMPT_REQUIREMENTS,
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
      /* Added when MRR finally declared its dependency. It is the prompt that
         most obviously needs a connector and it declared nothing, so the
         filter could never hide it and a CEO on a workspace with no QuickBooks
         was offered it anyway. */
      financials: false,
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
    /* DERIVED, NOT RESTATED. This was a hand-written list, so adding a fifth
       requirement broke it rather than being covered by it. A guardrail whose
       own list has to be edited by hand is a guardrail that drifts. */
    const known = new Set<string | undefined>([...PROMPT_REQUIREMENTS, undefined]);
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

/**
 * Leading with what just became possible.
 *
 * Filtering stops us pointing at walls. It does not tell anybody what the
 * product can now do. On 2026-08-28 the Brain held 1,251 documents, 665 of
 * them from SharePoint, all searchable, and not one starter prompt mentioned
 * asking about them. The four that came close were about uploading.
 *
 * A capability nobody is told about is a capability nobody uses.
 */
describe("surfacing a capability that is confirmed working", () => {
  /* Asserts the CLAIM, not the wording. This matched /documents say/i, which
     pinned the exact phrase "what do our documents say about X" — and that
     phrasing was measured on 2026-08-29 returning a result count rather than
     an answer, so it had to change. The claim worth guarding is that every kit
     offers a way into the corpus, not that it uses one particular sentence. */
  it("offers a document question in every kit", () => {
    for (const role of ["cto", "dev", "sales", "ops", "hr", "unknown-role"]) {
      const prompts = welcomePromptsForRole(role);
      expect(`${role}: ${prompts.some((p) => p.requires === "documents")}`).toBe(`${role}: true`);
    }
  });

  /* And it must stay a question. The product answers questions and returns a
     count for document commands, so a kit that taught "find" or "summarize"
     would be teaching the shape that works least well. */
  it("phrases that document prompt as a question in every kit", () => {
    for (const role of ["cto", "dev", "sales", "ops", "hr", "unknown-role"]) {
      const doc = welcomePromptsForRole(role).find((p) => p.requires === "documents");
      expect(`${role}: ${doc?.text.trim().endsWith("?")}`).toBe(`${role}: true`);
    }
  });

  it("puts a confirmed source first", () => {
    const out = welcomePromptsFor("cto", { documents: true });
    expect(out[0].requires).toBe("documents");
  });

  /* Confirmed means an explicit true. An unchecked source must not outrank one
     we know works, or the ordering is just noise. */
  it("does not promote a source that was merely not ruled out", () => {
    const out = welcomePromptsFor("cto", {});
    expect(out).toEqual(welcomePromptsForRole("cto"));
  });

  /* This promotes; it does not reshuffle. The order written in each kit still
     expresses what matters for that role. */
  it("keeps the kit's own order within each group", () => {
    const kit = welcomePromptsForRole("cto");
    const out = welcomePromptsFor("cto", { documents: true });

    const unconfirmed = out.filter((p) => p.requires !== "documents").map((p) => p.text);
    const kitOrder = kit.filter((p) => p.requires !== "documents").map((p) => p.text);
    expect(unconfirmed).toEqual(kitOrder);
  });

  it("still hides a confirmed-unavailable source while promoting a confirmed one", () => {
    const out = welcomePromptsFor("cto", { documents: true, calendar: false });
    expect(out[0].requires).toBe("documents");
    expect(out.some((p) => p.requires === "calendar")).toBe(false);
  });
});
