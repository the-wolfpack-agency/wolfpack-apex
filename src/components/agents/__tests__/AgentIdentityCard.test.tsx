/**
 * @jest-environment jsdom
 */

/**
 * The agent card, tested for what it must NOT imply.
 *
 * Giving an agent a face is what makes it approvable by a non-engineer, and it
 * is also how a card could talk someone into trusting something unproven. Every
 * test below is a version of the same question: does this look safer than the
 * evidence supports?
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import AgentIdentityCard from "../AgentIdentityCard";

function agent(over: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    name: "Research Scout",
    role: "Finds and summarizes source material",
    state: "active",
    connections: ["jira"],
    ...over,
  } as React.ComponentProps<typeof AgentIdentityCard>["agent"];
}

describe("who is this", () => {
  it("shows the name, role and a recognizable face", () => {
    render(<AgentIdentityCard agent={agent()} />);
    expect(screen.getByText("Research Scout")).toBeInTheDocument();
    expect(screen.getByText("Finds and summarizes source material")).toBeInTheDocument();
    expect(screen.getByTestId("agent-avatar")).toHaveTextContent("RS");
  });

  it("gives a misbehaving agent the SAME avatar treatment as a clean one", () => {
    // The core constraint. If a card can look friendlier, it can reassure
    // someone about an agent that has done something.
    const clean = render(<AgentIdentityCard agent={agent()} behavior={{ standing: "good", runs: 5 }} boundaryProven />);
    const cleanHue = screen.getByTestId("agent-avatar").getAttribute("data-hue");
    clean.unmount();

    render(<AgentIdentityCard agent={agent()} behavior={{ standing: "attention", runs: 5 }} boundaryProven />);
    expect(screen.getByTestId("agent-avatar").getAttribute("data-hue")).toBe(cleanHue);
  });

  it("keeps the avatar out of the red band, so red always means something", () => {
    render(<AgentIdentityCard agent={agent({ id: "whatever-id-99" })} />);
    const hue = Number(screen.getByTestId("agent-avatar").getAttribute("data-hue"));
    expect(hue).toBeGreaterThanOrEqual(30);
    expect(hue).toBeLessThan(330);
  });
});

describe("what can it touch", () => {
  it("names the systems concretely enough to approve or refuse", () => {
    render(<AgentIdentityCard agent={agent({ connections: ["salesforce", "github"] })} />);
    expect(screen.getByTestId("agent-capabilities")).toHaveTextContent(
      /your Salesforce records and your GitHub repositories/,
    );
  });

  it("says plainly when it can reach nothing", () => {
    // Reassuring and true. A blank space reads as missing information.
    render(<AgentIdentityCard agent={agent({ connections: [] })} />);
    expect(screen.getByTestId("agent-capabilities")).toHaveTextContent(/not connected to any of your systems/);
  });
});

describe("what has it done, and does that mean anything", () => {
  it("does NOT call an unscored agent fine", () => {
    // The most likely way this card does damage.
    render(<AgentIdentityCard agent={agent()} />);
    expect(screen.getByTestId("agent-trust")).toHaveTextContent(/nothing to judge it on/);
    expect(screen.getByText("Not established")).toBeInTheDocument();
  });

  it("does NOT call a clean record good when the boundary was never proven", () => {
    render(<AgentIdentityCard agent={agent()} behavior={{ standing: "good", runs: 12 }} boundaryProven={false} />);
    expect(screen.getByTestId("agent-trust")).toHaveTextContent(/not yet proved its limits hold/);
    expect(screen.getByText("Not established")).toBeInTheDocument();
  });

  it("reports Behaving only when the boundary was demonstrated", () => {
    render(<AgentIdentityCard agent={agent()} behavior={{ standing: "good", runs: 12 }} boundaryProven />);
    expect(screen.getByText("Behaving")).toBeInTheDocument();
    expect(screen.getByTestId("agent-trust")).toHaveTextContent(/Stayed inside its limits across 12 tasks/);
  });

  it("leads with misbehavior", () => {
    render(<AgentIdentityCard agent={agent()} behavior={{ standing: "attention", runs: 3 }} boundaryProven />);
    expect(screen.getByText("Needs a look")).toBeInTheDocument();
    expect(screen.getByTestId("agent-trust")).toHaveTextContent(/before this agent is given more access/);
  });

  it("does not present a paused agent as doing nothing wrong", () => {
    // Paused is about whether it CAN act, not about whether it behaved.
    render(<AgentIdentityCard agent={agent({ state: "paused" })} />);
    expect(screen.getByTestId("agent-state")).toHaveTextContent(/not acting/);
    expect(screen.getByTestId("agent-trust")).toHaveTextContent(/nothing to judge it on/);
  });
});

describe("what is behind it", () => {
  it("says a client's own model is governed identically", () => {
    // The sentence that makes bring-your-own-model adoptable: choosing your own
    // model does not opt you out of the checks.
    render(<AgentIdentityCard agent={agent()} model={{ id: "client:acme-llm", clientSupplied: true }} />);
    expect(screen.getByTestId("agent-model")).toHaveTextContent(/your own model/);
    expect(screen.getByTestId("agent-model")).toHaveTextContent(/exactly the same checks as ours/);
  });

  it("says when the model is ours", () => {
    render(<AgentIdentityCard agent={agent()} model={{ id: "azure-gpt-4o", clientSupplied: false }} />);
    expect(screen.getByTestId("agent-model")).toHaveTextContent(/supplied and governed by Wolfpack/);
  });

  it("omits the line rather than inventing a model", () => {
    render(<AgentIdentityCard agent={agent()} />);
    expect(screen.queryByTestId("agent-model")).not.toBeInTheDocument();
  });
});
