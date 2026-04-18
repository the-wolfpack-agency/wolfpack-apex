/**
 * @jest-environment jsdom
 */

/**
 * testimonial section renderer tests.
 *
 * Covers:
 *   - N valid items → N figures rendered, each with quote + author cite.
 *   - Semantic HTML: <figure>/<blockquote>/<figcaption>/<cite>.
 *   - Empty items + missing items → empty-state placeholder, no crash.
 *   - XSS smoke: <script> in quote/authorName renders as text, no <script>
 *     element is inserted.
 *   - Items missing required fields (quote OR authorName) are skipped
 *     individually; siblings still render.
 *   - authorPhotoUrl only renders when it begins with https://.
 *   - Dispatcher wiring: RenderSection routes type=testimonial to
 *     TestimonialSection.
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { TestimonialSection } from "@/components/sites/sections/testimonial";
import { RenderSection } from "@/components/sites/render-brief";

describe("TestimonialSection — happy paths", () => {
  it("renders N testimonials for N valid items", () => {
    render(
      <TestimonialSection
        section={{
          type: "testimonial",
          heading: "What they say",
          items: [
            { quote: "A+ service.", authorName: "Alice", authorTitle: "CTO" },
            { quote: "Changed my life.", authorName: "Bob" },
            { quote: "Indispensable.", authorName: "Carol", authorTitle: "Founder" },
          ],
        }}
      />,
    );
    const items = screen.getAllByTestId("testimonial-item");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("A+ service.");
    expect(items[0]).toHaveTextContent("Alice");
    expect(items[0]).toHaveTextContent("CTO");
    expect(items[1]).toHaveTextContent("Bob");
    expect(items[2]).toHaveTextContent("Carol");
  });

  it("uses semantic blockquote + cite elements per item", () => {
    const { container } = render(
      <TestimonialSection
        section={{
          type: "testimonial",
          items: [{ quote: "Hello world", authorName: "Jane" }],
        }}
      />,
    );
    expect(container.querySelector("figure")).not.toBeNull();
    expect(container.querySelector("blockquote")).not.toBeNull();
    expect(container.querySelector("cite")).not.toBeNull();
    expect(container.querySelector("figcaption")).not.toBeNull();
  });

  it("renders heading when provided", () => {
    render(
      <TestimonialSection
        section={{
          type: "testimonial",
          heading: "Loved by teams",
          items: [{ quote: "q", authorName: "a" }],
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Loved by teams" })).toBeInTheDocument();
  });

  it("renders authorPhotoUrl as <img> when https", () => {
    const { container } = render(
      <TestimonialSection
        section={{
          type: "testimonial",
          items: [
            {
              quote: "Great",
              authorName: "Zoe",
              authorPhotoUrl: "https://example.com/z.jpg",
            },
          ],
        }}
      />,
    );
    const img = container.querySelector("[data-testid='testimonial-photo']") as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("https://example.com/z.jpg");
  });

  it("does not render photo for non-https authorPhotoUrl (XSS safety)", () => {
    const { container } = render(
      <TestimonialSection
        section={{
          type: "testimonial",
          items: [
            {
              quote: "hi",
              authorName: "Eve",
              authorPhotoUrl: "javascript:alert(1)" as unknown as string,
            },
          ],
        }}
      />,
    );
    expect(container.querySelector("[data-testid='testimonial-photo']")).toBeNull();
  });
});

describe("TestimonialSection — empty / invalid", () => {
  it("renders empty state when items is missing", () => {
    render(<TestimonialSection section={{ type: "testimonial", heading: "t" }} />);
    expect(screen.getByTestId("testimonial-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("testimonial-item")).not.toBeInTheDocument();
  });

  it("renders empty state when items is an empty array", () => {
    render(<TestimonialSection section={{ type: "testimonial", items: [] }} />);
    expect(screen.getByTestId("testimonial-empty")).toBeInTheDocument();
  });

  it("skips items missing quote OR authorName (still renders valid siblings)", () => {
    render(
      <TestimonialSection
        section={{
          type: "testimonial",
          items: [
            { quote: "", authorName: "NoQuote" }, // skipped — empty quote
            { quote: "only quote" }, // skipped — no authorName
            { quote: "valid", authorName: "Valid Author" }, // rendered
          ],
        }}
      />,
    );
    const items = screen.getAllByTestId("testimonial-item");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("valid");
    expect(items[0]).toHaveTextContent("Valid Author");
  });
});

describe("TestimonialSection — XSS smoke", () => {
  it("escapes <script> in quote and authorName (renders as text)", () => {
    const { container } = render(
      <TestimonialSection
        section={{
          type: "testimonial",
          items: [
            {
              quote: "<script>alert('q')</script>",
              authorName: "<script>alert('a')</script>",
              authorTitle: "<script>alert('t')</script>",
            },
          ],
        }}
      />,
    );
    const section = screen.getByTestId("testimonial-section");
    expect(section.querySelector("script")).toBeNull();
    expect(section).toHaveTextContent("<script>alert('q')</script>");
    expect(section).toHaveTextContent("<script>alert('a')</script>");
    expect(container.innerHTML).toContain("&lt;script&gt;");
  });
});

describe("RenderSection dispatcher — testimonial routing", () => {
  it("routes type=testimonial to TestimonialSection", () => {
    render(
      <RenderSection
        index={0}
        section={{
          type: "testimonial",
          items: [{ quote: "q", authorName: "n" }],
        }}
      />,
    );
    expect(screen.getByTestId("testimonial-section")).toHaveAttribute(
      "data-section-type",
      "testimonial",
    );
  });
});
