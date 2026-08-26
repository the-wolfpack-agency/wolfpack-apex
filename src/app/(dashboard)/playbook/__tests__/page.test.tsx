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
import { render, screen } from "@testing-library/react";
import PlaybookPage from "../page";
import { CLIENT_DEPLOYMENT_PLAYBOOK } from "@/lib/playbook";

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
