/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import AgenticQAPipeline from "@/components/engineering/AgenticQAPipeline";

describe("AgenticQAPipeline", () => {
  it("renders the input, every gate, and the verified output", () => {
    render(<AgenticQAPipeline />);
    const diagram = screen.getByTestId("agenticqa-pipeline");
    expect(diagram).toBeInTheDocument();

    // Input and output terminals.
    expect(within(diagram).getByText(/A change is proposed/i)).toBeInTheDocument();
    expect(within(diagram).getByText(/Live in production, verified/i)).toBeInTheDocument();

    // Each named gate is present.
    for (const gate of [
      "Local verify",
      "Pull request opened",
      "CI gate",
      "Security & dependencies",
      "Human review",
      "Deploy",
      "Live verification",
    ]) {
      expect(within(diagram).getByText(gate)).toBeInTheDocument();
    }
  });

  it("explains the fail path (blocked, returned, never reaches production)", () => {
    render(<AgenticQAPipeline />);
    const diagram = screen.getByTestId("agenticqa-pipeline");
    expect(within(diagram).getByText(/If any gate fails/i)).toBeInTheDocument();
    expect(within(diagram).getByText(/never reaches\s+production/i)).toBeInTheDocument();
  });

  it("has an accessible description of the whole flow", () => {
    render(<AgenticQAPipeline />);
    // role="img" + aria-label so screen readers get the gist without the boxes.
    expect(screen.getByRole("img", { name: /AgenticQA pipeline flow/i })).toBeInTheDocument();
  });
});
