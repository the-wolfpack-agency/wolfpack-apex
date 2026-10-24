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

describe("enforcement-era steps", () => {
  const steps2: JourneyStep[] = [
    { at: "2026-10-20T10:00:00Z", path: "/api/x", signal: "payload_attack", attack: "nextjs_middleware_bypass", blocked: true },
    { at: "2026-10-20T10:00:01Z", path: "/index.php", signal: "payload_attack", attack: "php_cgi_injection", wouldBlock: true },
    { at: "2026-10-20T10:00:02Z", path: "/_next/action", signal: "probed_sensitive", probe: "next_server_action" },
    { at: "2026-10-20T10:00:03Z", path: "/", signal: "high_rate", rate: 52 },
    { at: "2026-10-20T10:00:04Z", path: "/.env", signal: "probed_sensitive", probe: "/.env" },
    { at: "2026-10-20T10:00:05Z", path: "/y", signal: "payload_attack", attack: "brand_new_family" },
  ];

  test("a blocked step says blocked and reads as hostile", () => {
    render(<AgentJourneyTimeline steps={steps2} />);
    const s0 = screen.getByTestId("journey-timeline-step-0");
    expect(s0).toHaveAttribute("data-outcome", "blocked");
    expect(screen.getByTestId("journey-timeline-step-0-outcome")).toHaveTextContent("blocked");
    expect(s0).toHaveTextContent(/payload: Next\.js middleware bypass/);
    expect(s0.className).toMatch(/wp-jt-node--bad/);
  });

  test("a withheld block says would block, never blocked", () => {
    render(<AgentJourneyTimeline steps={steps2} />);
    expect(screen.getByTestId("journey-timeline-step-1-outcome")).toHaveTextContent("would block");
    expect(screen.getByTestId("journey-timeline-step-1")).toHaveTextContent(/PHP-CGI argument injection/);
    expect(screen.getByTestId("journey-timeline-step-1").getAttribute("title")).toMatch(/let through/);
  });

  test("names engine probe labels, shows burst rate, keeps path probes as paths", () => {
    render(<AgentJourneyTimeline steps={steps2} />);
    expect(screen.getByTestId("journey-timeline-step-2")).toHaveTextContent(/Next\.js server action probe/);
    expect(screen.getByTestId("journey-timeline-step-3")).toHaveTextContent(/high rate: 52 requests/);
    expect(screen.getByTestId("journey-timeline-step-4")).toHaveTextContent(/probed sensitive/);
    expect(screen.queryByTestId("journey-timeline-step-2-outcome")).not.toBeInTheDocument();
  });

  test("an unknown payload family still renders, de-underscored", () => {
    render(<AgentJourneyTimeline steps={steps2} />);
    expect(screen.getByTestId("journey-timeline-step-5")).toHaveTextContent(/payload: brand new family/);
  });
});
