/**
 * @jest-environment jsdom
 *
 * The staged "your answer is coming" indicator.
 *
 * What matters: it starts on the first real stage, advances through them on a
 * timer so the wait doesn't look frozen, and HOLDS on the last stage rather
 * than wrapping back to the start (which would read as the request restarting).
 */

import "@testing-library/jest-dom";
import { render, screen, act } from "@testing-library/react";
import AssistantThinkingIndicator, {
  THINKING_PHASES,
} from "@/components/AssistantThinkingIndicator";

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

describe("AssistantThinkingIndicator", () => {
  it("starts on the first phase", () => {
    render(<AssistantThinkingIndicator intervalMs={100} />);
    expect(screen.getByTestId("thinking-phase")).toHaveTextContent(THINKING_PHASES[0]);
  });

  it("advances to the next phase on the timer", () => {
    render(<AssistantThinkingIndicator intervalMs={100} />);
    act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(screen.getByTestId("thinking-phase")).toHaveTextContent(THINKING_PHASES[1]);
  });

  it("holds on the last phase and never wraps back to the first", () => {
    render(<AssistantThinkingIndicator intervalMs={100} />);
    // Advance step by step: each phase schedules its next timeout only after
    // the render commits, so React has to flush between ticks (one act per tick).
    for (let i = 0; i < THINKING_PHASES.length + 5; i++) {
      act(() => {
        jest.advanceTimersByTime(100);
      });
    }
    expect(screen.getByTestId("thinking-phase")).toHaveTextContent(
      THINKING_PHASES[THINKING_PHASES.length - 1],
    );
  });

  it("reports non-zero stage progress", () => {
    render(<AssistantThinkingIndicator intervalMs={100} />);
    const bar = screen.getByTestId("thinking-progress");
    expect(Number(bar.getAttribute("data-progress"))).toBeGreaterThan(0);
  });
});
