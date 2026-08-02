/**
 * @jest-environment jsdom
 */

/**
 * The fleet behaviour panel.
 *
 * Every test here is about the panel refusing to imply something it does not
 * know. The reader is deciding whether an agent gets access to a client system;
 * a green tick they misread costs more than a blank panel.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import FleetBehaviorPanel from "../FleetBehaviorPanel";
import type { AgentBehaviorSummary } from "@/lib/agents/evals/behavior-summary";

function agent(over: Partial<AgentBehaviorSummary> = {}): AgentBehaviorSummary {
  return {
    agentId: "a1",
    runs: 3,
    containment: { pass: 3, fail: 0, unproven: 0 },
    honesty: { pass: 3, fail: 0, unproven: 0 },
    findingKinds: [],
    lastScoredAt: "2026-08-01T10:00:00.000Z",
    headline: "Stayed inside its limits across 3 runs, and its account matched the record every time.",
    standing: "good",
    ...over,
  };
}

describe("when there is nothing to report", () => {
  it("says so is NOT the same as all clear", () => {
    // The panel's worst possible failure would be rendering "no findings" as
    // reassurance on a fleet that has never been scored.
    render(<FleetBehaviorPanel agents={[]} days={30} />);
    const empty = screen.getByTestId("fleet-behavior-empty");
    expect(empty).toHaveTextContent(/not a clean bill of health/i);
    expect(empty).toHaveTextContent(/absence of evidence/i);
  });

  it("shows a loading state rather than an empty one while checking", () => {
    // An empty state during load reads as "nothing found", which is a claim.
    render(<FleetBehaviorPanel agents={[]} days={30} loading />);
    expect(screen.getByTestId("fleet-behavior-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("fleet-behavior-empty")).not.toBeInTheDocument();
  });
});

describe("the three states", () => {
  it("renders an unproven agent NEUTRAL, never green", () => {
    // Rendering "we have not checked" in the same colour as "we checked and it
    // was fine" is the single most likely way this panel could mislead.
    render(<FleetBehaviorPanel agents={[agent({ standing: "unknown" })]} days={30} />);
    const pill = screen.getByTestId("status-pill");
    expect(pill).toHaveAttribute("data-tone", "neutral");
    expect(pill).toHaveTextContent("Not established");
  });

  it("renders a misbehaving agent as needing a look", () => {
    render(<FleetBehaviorPanel agents={[agent({ standing: "attention" })]} days={30} />);
    const pill = screen.getByTestId("status-pill");
    expect(pill).toHaveAttribute("data-tone", "error");
    expect(pill).toHaveTextContent("Needs a look");
  });

  it("renders a clean agent as behaving", () => {
    render(<FleetBehaviorPanel agents={[agent()]} days={30} />);
    expect(screen.getByTestId("status-pill")).toHaveAttribute("data-tone", "success");
  });
});

describe("the words", () => {
  it("shows the sentence from the summary, not a verdict string", () => {
    render(<FleetBehaviorPanel agents={[agent()]} days={30} />);
    expect(screen.getByText(/its account matched the record every time/i)).toBeInTheDocument();
  });

  it("translates finding ids into something a non-engineer can read", () => {
    render(<FleetBehaviorPanel agents={[agent({ findingKinds: ["egress-attempt"] })]} days={30} />);
    expect(screen.getByText(/tried to reach outside its limits and was stopped/i)).toBeInTheDocument();
    expect(screen.queryByText(/egress-attempt/)).not.toBeInTheDocument();
  });

  it("still shows an unrecognised finding rather than hiding it", () => {
    // A kind added later must not vanish from the report just because no one
    // has written its sentence yet.
    render(<FleetBehaviorPanel agents={[agent({ findingKinds: ["something-new"] })]} days={30} />);
    expect(screen.getByText(/something-new/)).toBeInTheDocument();
  });

  it("uses a human name when the caller knows one", () => {
    render(<FleetBehaviorPanel agents={[agent()]} days={30} nameFor={() => "Scout"} />);
    expect(screen.getByText("Scout")).toBeInTheDocument();
  });

  it("falls back to the id rather than rendering nothing", () => {
    render(<FleetBehaviorPanel agents={[agent()]} days={30} nameFor={() => undefined} />);
    expect(screen.getByText("a1")).toBeInTheDocument();
  });
});

describe("the count that gets acted on", () => {
  it("leads with how many agents need attention", () => {
    render(
      <FleetBehaviorPanel
        agents={[agent({ agentId: "a1", standing: "attention" }), agent({ agentId: "a2", standing: "good" })]}
        days={30}
      />,
    );
    expect(screen.getByTestId("fleet-behavior-attention")).toHaveTextContent("1 agent needs a look.");
  });

  it("gets the plural right, because '1 agents' reads as a bug", () => {
    render(
      <FleetBehaviorPanel
        agents={[agent({ agentId: "a1", standing: "attention" }), agent({ agentId: "a2", standing: "attention" })]}
        days={30}
      />,
    );
    expect(screen.getByTestId("fleet-behavior-attention")).toHaveTextContent("2 agents need a look.");
  });

  it("does not show the banner when nothing needs attention", () => {
    render(<FleetBehaviorPanel agents={[agent()]} days={30} />);
    expect(screen.queryByTestId("fleet-behavior-attention")).not.toBeInTheDocument();
  });

  it("does not count an unproven agent as needing attention", () => {
    // Unproven is not an accusation. Counting it here would cry wolf on a fleet
    // that has simply never had its self-test run.
    render(<FleetBehaviorPanel agents={[agent({ standing: "unknown" })]} days={30} />);
    expect(screen.queryByTestId("fleet-behavior-attention")).not.toBeInTheDocument();
  });
});
