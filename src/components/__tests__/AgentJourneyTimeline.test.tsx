/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { AgentJourneyTimeline } from "@/components/AgentJourneyTimeline";
import type { JourneyStep } from "@/lib/agent-behavior";

const steps: JourneyStep[] = [
  { at: "2026-09-19T10:00:00Z", path: "/", signal: null },
  { at: "2026-09-19T10:00:01Z", path: "/agentic-qa", signal: null },
  { at: "2026-09-19T10:00:03Z", path: "/_ff/x", signal: "tripped_decoy" },
  { at: "2026-09-19T10:00:05Z", path: "/.env", signal: "probed_sensitive" },
  { at: "2026-09-19T10:00:07Z", path: "/login", signal: "payload_attack", attack: "sql_injection" },
];

test("chains the path in order and labels each node", () => {
  render(<AgentJourneyTimeline steps={steps} />);
  const tl = screen.getByTestId("journey-timeline");
  expect(tl).toBeInTheDocument();
  expect(screen.getByTestId("journey-timeline-step-0")).toHaveAttribute("data-signal", "visit");
  expect(screen.getByTestId("journey-timeline-step-0")).toHaveTextContent("/");
  expect(screen.getByTestId("journey-timeline-step-3")).toHaveTextContent("/.env");
});

test("highlights the honeypot trip as a hostile node", () => {
  render(<AgentJourneyTimeline steps={steps} />);
  const decoy = screen.getByTestId("journey-timeline-step-2");
  expect(decoy).toHaveAttribute("data-signal", "tripped_decoy");
  expect(decoy).toHaveTextContent(/TRIPPED DECOY/i);
  expect(decoy.className).toMatch(/wp-jt-node--bad/);
});

test("names the payload kind on a payload node", () => {
  render(<AgentJourneyTimeline steps={steps} />);
  expect(screen.getByTestId("journey-timeline-step-4")).toHaveTextContent(/payload: sql injection/i);
});

test("renders nothing when there are no steps (graceful for older data)", () => {
  const { container } = render(<AgentJourneyTimeline steps={[]} />);
  expect(container).toBeEmptyDOMElement();
});
