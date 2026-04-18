/**
 * @jest-environment jsdom
 */

/**
 * faq section renderer tests.
 *
 * Covers:
 *   - N valid items → N <details>/<summary> pairs rendered.
 *   - Semantic HTML: native <details> + <summary> so the component is
 *     usable without client JS (no framework dependency for collapse).
 *   - Empty / missing items → empty-state placeholder, no crash.
 *   - XSS smoke: <script> in question/answer renders as text.
 *   - Items missing question OR answer are skipped individually; siblings
 *     still render.
 *   - Dispatcher wiring: RenderSection routes type=faq to FaqSection.
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { FaqSection } from "@/components/sites/sections/faq";
import { RenderSection } from "@/components/sites/render-brief";

describe("FaqSection — happy paths", () => {
  it("renders N question/answer pairs", () => {
    render(
      <FaqSection
        section={{
          type: "faq",
          heading: "FAQ",
          items: [
            { question: "What is it?", answer: "It is a tool." },
            { question: "How much?", answer: "$29/mo." },
            { question: "Cancel anytime?", answer: "Yes." },
          ],
        }}
      />,
    );
    const items = screen.getAllByTestId("faq-item");
    expect(items).toHaveLength(3);

    const questions = screen.getAllByTestId("faq-question");
    const answers = screen.getAllByTestId("faq-answer");
    expect(questions[0]).toHaveTextContent("What is it?");
    expect(answers[0]).toHaveTextContent("It is a tool.");
    expect(questions[2]).toHaveTextContent("Cancel anytime?");
    expect(answers[2]).toHaveTextContent("Yes.");
  });

  it("uses native <details>/<summary> for JS-free collapse", () => {
    const { container } = render(
      <FaqSection
        section={{
          type: "faq",
          items: [{ question: "q", answer: "a" }],
        }}
      />,
    );
    expect(container.querySelector("details")).not.toBeNull();
    expect(container.querySelector("summary")).not.toBeNull();
  });

  it("renders heading when provided", () => {
    render(
      <FaqSection
        section={{
          type: "faq",
          heading: "Common questions",
          items: [{ question: "q", answer: "a" }],
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Common questions" })).toBeInTheDocument();
  });

  it("renders a single-item FAQ cleanly", () => {
    render(
      <FaqSection
        section={{
          type: "faq",
          items: [{ question: "Only one?", answer: "Yes, only one." }],
        }}
      />,
    );
    expect(screen.getAllByTestId("faq-item")).toHaveLength(1);
    expect(screen.getByText("Only one?")).toBeInTheDocument();
    expect(screen.getByText("Yes, only one.")).toBeInTheDocument();
  });
});

describe("FaqSection — empty / invalid", () => {
  it("renders empty state when items is missing", () => {
    render(<FaqSection section={{ type: "faq", heading: "FAQ" }} />);
    expect(screen.getByTestId("faq-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("faq-item")).not.toBeInTheDocument();
  });

  it("renders empty state when items is an empty array", () => {
    render(<FaqSection section={{ type: "faq", items: [] }} />);
    expect(screen.getByTestId("faq-empty")).toBeInTheDocument();
  });

  it("skips items missing question OR answer (renders valid siblings)", () => {
    render(
      <FaqSection
        section={{
          type: "faq",
          items: [
            { question: "", answer: "no q" }, // skipped
            { question: "no a" }, // skipped
            { answer: "no q" }, // skipped
            { question: "Valid?", answer: "Yes!" }, // rendered
          ],
        }}
      />,
    );
    const items = screen.getAllByTestId("faq-item");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("Valid?");
    expect(items[0]).toHaveTextContent("Yes!");
  });
});

describe("FaqSection — XSS smoke", () => {
  it("escapes <script> in question and answer (renders as text)", () => {
    const { container } = render(
      <FaqSection
        section={{
          type: "faq",
          items: [
            {
              question: "<script>alert('q')</script>",
              answer: "<script>alert('a')</script>",
            },
          ],
        }}
      />,
    );
    const section = screen.getByTestId("faq-section");
    expect(section.querySelector("script")).toBeNull();
    expect(section).toHaveTextContent("<script>alert('q')</script>");
    expect(section).toHaveTextContent("<script>alert('a')</script>");
    expect(container.innerHTML).toContain("&lt;script&gt;");
  });
});

describe("RenderSection dispatcher — faq routing", () => {
  it("routes type=faq to FaqSection", () => {
    render(
      <RenderSection
        index={0}
        section={{
          type: "faq",
          items: [{ question: "q", answer: "a" }],
        }}
      />,
    );
    expect(screen.getByTestId("faq-section")).toHaveAttribute(
      "data-section-type",
      "faq",
    );
  });
});
