/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { AgentActionLog } from "@/components/AgentActionLog";
import type { JourneyStep } from "@/lib/agent-behavior";

const steps: JourneyStep[] = [
  { at: "2026-09-20T10:00:00Z", path: "/robots.txt", signal: "read_robots" },
  { at: "2026-09-20T10:00:09Z", path: "/wp-login.php", signal: "probed_sensitive" },
  { at: "2026-09-20T10:00:20Z", path: "/", signal: null },
];

describe("AgentActionLog", () => {
  it("renders the case file with phase bands, timestamps, and plain-language details", () => {
    render(<AgentActionLog steps={steps} testId="cf" />);
    expect(screen.getByTestId("cf")).toBeInTheDocument();
    // phase bands appear as the narrative crosses the incident
    expect(screen.getByTestId("cf-phase-lead_up")).toBeInTheDocument();
    expect(screen.getByTestId("cf-phase-hostile_act")).toBeInTheDocument();
    expect(screen.getByTestId("cf-phase-aftermath")).toBeInTheDocument();
    // an entry per step, with a plain sentence and the wall clock
    expect(screen.getByTestId("cf-entry-1")).toHaveTextContent(/looking for a way in/i);
    expect(screen.getByTestId("cf-entry-0")).toHaveTextContent("10:00:00");
    expect(screen.getByTestId("cf-headline-1")).toHaveTextContent(/probed sensitive/i);
  });

  it("labels the phase 'Activity' (not lead-up) when nothing hostile happened", () => {
    render(<AgentActionLog steps={[{ at: "2026-09-20T10:00:00Z", path: "/faq", signal: "identified_agent" }]} testId="cf2" />);
    expect(screen.getByTestId("cf2-phase-lead_up")).toHaveTextContent(/activity/i);
  });

  it("renders nothing with no steps", () => {
    const { container } = render(<AgentActionLog steps={[]} testId="cf3" />);
    expect(container).toBeEmptyDOMElement();
  });
});
