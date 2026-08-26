/**
 * @jest-environment jsdom
 */
/**
 * The playbook renders, and says the things it exists to say.
 *
 * A plan nobody opens is a plan nobody follows, which is why this is a page
 * rather than a file in a folder. These assert the parts a reader comes
 * looking for, so a future edit that quietly drops one fails here rather than
 * in front of a client.
 */
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import PlaybookPage from "../page";
import { CLIENT_DEPLOYMENT_PLAYBOOK } from "@/lib/playbook";
import { renderMarkdown, headingSlug } from "@/lib/markdown";

describe("the client deployment playbook page", () => {
  it("renders", () => {
    render(<PlaybookPage />);
    expect(screen.getByTestId("client-deployment-playbook")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /client deployment playbook/i }),
    ).toBeInTheDocument();
  });

  /* The order IS the argument: read before write, one system before two, and
     the thing that proves value before the thing that costs most to integrate. */
  it.each([
    "Phase 1: documents, read only",
    "Phase 2: the personas",
    "Phase 3: one workflow that crosses systems",
    "Phase 4: a second system, still read only",
    "Phase 5: writes, and only then",
  ])("keeps the phase: %s", (phase) => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toContain(phase);
  });

  /* The part that consumes more of month one than the build does. Dropping it
     is how a pilot slips without anybody noticing until it has. */
  it("still opens with what has to exist before anything", () => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(/tenant consent/i);
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(/test account per persona/i);
  });

  /* The part a plan usually omits. */
  it("still says when to stop and re-plan", () => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(/When to stop and re-plan/i);
  });

  /* Written for a person, not for a build log. */
  it("does not leak our architecture into a client-facing promise", () => {
    const promises = CLIENT_DEPLOYMENT_PLAYBOOK.split("What we say plainly to a client")[1] ?? "";
    expect(promises.length).toBeGreaterThan(50);
    expect(promises).not.toMatch(/Qdrant|jsdom|serverless|regex/i);
  });

  it("renders the tables the markdown relies on", () => {
    render(<PlaybookPage />);
    expect(document.querySelectorAll("table").length).toBeGreaterThan(0);
  });
});

/* ---------------------------------------------------------------------
 * The architecture a client's technical reviewer will ask for.
 *
 * Every part named is running in this product today. The value of writing it
 * down is that the team says the same thing, and that a claim which stops
 * being true fails a test rather than surviving in a deck.
 * --------------------------------------------------------------- */
describe("the system described to a client", () => {
  it.each([
    "The system we build for them",
    "Data flow, phase 1",
    "Where their data lives",
    "Who may see what",
    "What is recorded",
    "Model governance",
    "The ontology",
    "What each phase adds",
  ])("keeps the section: %s", (section) => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toContain(section);
  });

  /* The three gates are separate on purpose, and collapsing them into one is
     the kind of simplification that quietly removes a guarantee. */
  it.each(["Role.", "Audience.", "Tenancy."])("names the %s gate", (gate) => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toContain(gate);
  });

  it("says the gates fail closed", () => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(/fail closed/i);
  });

  /* One client, one database, is the sentence a corporate buyer listens for. */
  it("states the tenancy model plainly", () => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(/One client, one database/i);
  });

  /* Phases 1 to 4 write nothing. If that ever stops being true in the table,
     it must be a decision somebody made rather than a drift. */
  it("promises no writes before the final phase", () => {
    const table = CLIENT_DEPLOYMENT_PLAYBOOK.split("What each phase adds")[1] ?? "";
    const rows = table.split("\n").filter((l) => /^\| [1-4] \|/.test(l));
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row).toMatch(/None\s*\|$/);
  });
});

/* ---------------------------------------------------------------------
 * The agent section.
 *
 * The client asks about agents. The honest answer is that the agent is the
 * least novel part and the gate around it is the product, which is a harder
 * thing to say and a much stronger one.
 * --------------------------------------------------------------- */
describe("agents, and the gate", () => {
  it("keeps the section", () => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toContain("The agents, and the gate that makes them safe");
  });

  /* The sentence the whole section exists to support. */
  it("says a model proposes and the gate decides", () => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(/model proposes; the gate decides, executes and records/i);
  });

  it("says an agent acts on behalf of a person, never as itself", () => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(/acts as a person, never as itself/i);
  });

  it.each([
    "Operation registry",
    "Approvals",
    "Grounding",
    "Behaviour evals",
    "Drift detection",
    "Failover",
    "Audit",
  ])("names the %s layer", (layer) => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toContain(layer);
  });

  /* Sequencing discipline: choosing the automation before finding the work is
     how automation projects produce something nobody uses. */
  it("keeps agents out of phase one", () => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(/Not in phase one/i);
  });
});

/**
 * The questions a client asks, and whether we still answer them.
 *
 * Every answer in this section is a claim about something that exists today.
 * That is exactly the kind of text that rots: a control gets renamed, a
 * boundary gets softened to sound better, and nobody notices until it is being
 * read back to us in a room. These pin the claims that would be embarrassing
 * to have quietly lost, and the two boundaries we must never overstate.
 */
describe("the questions they will ask", () => {
  it("keeps the section", () => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toContain(
      "The questions they will ask, and the answer we already have",
    );
  });

  it.each([
    ["separate databases per client", /One client, one database/i],
    ["the build-failing tenancy scan", /fails the build if any workspace-scoped query is missing its filter/i],
    ["redaction in both directions", /redacted for credentials and identifiers on\s*the way out and again on the way back/i],
    ["not training on their data", /is not used to\s*train a model/i],
    ["the audit log holding no content", /holds the reference, never the content/i],
    ["an agent being unable to invent a capability", /cannot invent a capability/i],
    ["a named accountable person", /who acted, and who authorised/i],
    ["refusing rather than guessing", /refused rather than guessed/i],
    ["untrusted retrieved text", /marked as untrusted/i],
    ["the exportable source of truth", /It is their database/i],
  ])("still answers on %s", (_label, pattern) => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(pattern);
  });

  /* The ceiling, in the words that make it a control rather than a setting.
     A ceiling that is not counted on refusals, or that opens when it cannot be
     read, is not a ceiling, so the answer has to keep saying both. */
  it("answers what stops an agent running away, and how", () => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(/What stops it running away/i);
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(/hourly ceiling/i);
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(/per agent rather than per workspace/i);
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(/Refused attempts are counted/i);
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(/the agent does not\s*act/i);
  });

  /* Two things the playbook must not raise, for the same reason: they are not
     built out yet. Asserted as ABSENCES, which is the only form of this test
     that works. A claim we do not make cannot be softened into one we do
     without deleting a test, and deleting a test is a decision somebody makes
     on purpose rather than while editing for confidence. */
  it("does not claim MFA anywhere, because it is not shipped", () => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).not.toMatch(/\bMFA\b|multi-factor/i);
  });

  it("does not raise post-quantum, because it is not built out yet", () => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).not.toMatch(/quantum/i);
  });

  /* Writes stay behind a person in the answer as well as in the phase table.
     Two places saying it differently is how a promise drifts. */
  it("keeps writes behind a person and behind phase five", () => {
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(/Not until phase five/i);
    expect(CLIENT_DEPLOYMENT_PLAYBOOK).toMatch(/requires an approval before it runs/i);
  });
});

/**
 * The document has to be readable, not merely correct.
 *
 * It shipped with the right words and no styling: headings at body weight,
 * table cells run together into "Microsoft 365 tenant consentTheir IT", and
 * both architecture diagrams collapsed into prose because they were indented
 * rather than fenced. Every assertion above passed the whole time, because
 * they all read the source string and none of them looked at what a person
 * actually gets.
 */
describe("the playbook renders as a document a person can read", () => {
  const html = renderMarkdown(CLIENT_DEPLOYMENT_PLAYBOOK);

  /* Indented blocks are not code blocks to this renderer, so an ASCII diagram
     written that way silently becomes a paragraph of run-together spaces.
     That is exactly how both diagrams were lost. */
  it("keeps the architecture diagrams as diagrams", () => {
    expect((html.match(/<pre>/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).toMatch(/<pre><code>their people/);
  });

  it("renders the tables as tables", () => {
    expect((html.match(/<table>/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it("gives every section an anchor, so the contents rail can reach it", () => {
    const headings = CLIENT_DEPLOYMENT_PLAYBOOK.split("\n").filter((l) => /^##\s+/.test(l));
    expect(headings.length).toBeGreaterThan(5);
    for (const h of headings) {
      expect(html).toContain(`id="${headingSlug(h.replace(/^##\s+/, "").trim())}"`);
    }
  });

  it("carries a contents entry for every section", () => {
    render(<PlaybookPage />);
    const nav = screen.getByRole("navigation", { name: /sections/i });
    const links = within(nav).getAllByRole("link");
    const sectionCount = CLIENT_DEPLOYMENT_PLAYBOOK.split("\n").filter((l) =>
      /^##\s+/.test(l),
    ).length;
    expect(links).toHaveLength(sectionCount);
  });

  /* The body must claim the shared stylesheet. Without the class the page
     renders exactly as it shipped: correct, and unreadable. */
  it("applies the shared markdown styling", () => {
    render(<PlaybookPage />);
    expect(screen.getByTestId("client-deployment-playbook").querySelector(".wp-md")).not.toBeNull();
  });
});
