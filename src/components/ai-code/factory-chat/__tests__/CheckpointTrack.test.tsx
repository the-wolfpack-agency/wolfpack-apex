/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import CheckpointTrack from "@/components/ai-code/factory-chat/CheckpointTrack";

it("renders a dot per checkpoint with its status, and the blocked reason", () => {
  render(<CheckpointTrack checkpoints={[
    { id: "a", label: "Code generated", status: "clear" },
    { id: "b", label: "Security checks", status: "blocked", detail: "A critical issue was withheld." },
    { id: "c", label: "Ready for review", status: "held" },
    { id: "d", label: "UI tests", status: "pending" },
  ]} />);
  const dots = screen.getAllByTestId("checkpoint");
  expect(dots).toHaveLength(4);
  expect(dots[0]).toHaveAttribute("data-status", "clear");
  expect(dots[1]).toHaveAttribute("data-status", "blocked");
  expect(screen.getByText(/A critical issue was withheld/)).toBeInTheDocument();
});

it("renders nothing when there are no checkpoints", () => {
  const { container } = render(<CheckpointTrack checkpoints={[]} />);
  expect(container.firstChild).toBeNull();
});
